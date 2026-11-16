import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { claimsSpawn, claimsSpawnWithoutId, sanitizeSpawnClaims } from '../assistant/spawnClaim.js';

/**
 * 从上下文里剔除"声称派活"的旧消息。
 *
 * ## 为什么需要
 *
 * 用户反馈：**Assistant 很难主动调用 Agent，要说很多次"需要"才动**。
 *
 * 根因不是提示词不够，而是**上下文污染**：
 * 历史里积了几十条「已派出 exe_xxx」的 assistant 消息，
 * 模型照着模仿句式，只写文字不调工具。
 *
 * 实测用户的库：793 条 assistant 消息里 59 条含「已派出」，
 * 最严重的会话 25 条。
 *
 * 原来的重试只 `messages.pop()` 一条，剩下 24 条还当范本。
 */

type Msg = { readonly role: string; readonly content: string | null };

describe('**剔除声称派活的旧消息**', () => {
  it('带 id 的「已派出」被剔除', () => {
    const msgs: Msg[] = [
      { role: 'user', content: '派个 Agent 查一下' },
      { role: 'assistant', content: '已派出 exe_abc123，正在跑。' },
    ];
    const out = sanitizeSpawnClaims(msgs);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, 'user');
  });

  it('**不带 id 的「已派出」也剔除**', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: '已派出，两个都在跑。' },
    ];
    assert.equal(sanitizeSpawnClaims(msgs).length, 0);
  });

  it('多条旧样板一起清掉', () => {
    // 复刻真实会话：25 条「已派出」
    const msgs: Msg[] = [];
    for (let i = 0; i < 25; i += 1) {
      msgs.push({ role: 'user', content: `任务 ${i}` });
      msgs.push({ role: 'assistant', content: `已派出 exe_test${i}，正在跑。` });
    }
    const out = sanitizeSpawnClaims(msgs);
    // 只剩 25 条 user
    assert.equal(out.length, 25);
    assert.ok(out.every((m) => m.role === 'user'));
  });
});

describe('**该保留的要保留**', () => {
  it('普通回复不动', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: '这个问题的答案是 42。' },
      { role: 'assistant', content: '我看了一下源码，问题在缓存。' },
    ];
    assert.equal(sanitizeSpawnClaims(msgs).length, 2);
  });

  it('**用户消息一条都不能删**', () => {
    const msgs: Msg[] = [
      { role: 'user', content: '你派出去了吗？' },
      { role: 'user', content: '需要' },
      { role: 'user', content: '已派出是什么意思' },
    ];
    assert.equal(sanitizeSpawnClaims(msgs).length, 3);
  });

  it('**更正消息保留**（它是真相，删了模型会以为真派过）', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: '⚠ **更正**：上一条说的「已派出 exe_abc」不成立——本轮实际没有创建任何 Agent。',
      },
    ];
    const out = sanitizeSpawnClaims(msgs);
    assert.equal(out.length, 1, '更正消息不该被删掉');
  });

  it('「实际没有创建」的也算更正', () => {
    const msgs: Msg[] = [
      { role: 'assistant', content: '已派出 exe_x —— 更正：实际没有创建任何 Agent。' },
    ];
    assert.equal(sanitizeSpawnClaims(msgs).length, 1);
  });

  it('system 消息不动', () => {
    const msgs: Msg[] = [{ role: 'system', content: '你是 Assistant。' }];
    assert.equal(sanitizeSpawnClaims(msgs).length, 1);
  });

  it('content 为 null 不炸', () => {
    const msgs: Msg[] = [{ role: 'assistant', content: null }];
    assert.equal(sanitizeSpawnClaims(msgs).length, 1);
  });
});

describe('混合场景', () => {
  it('只剔除模板，保留其余', () => {
    const msgs: Msg[] = [
      { role: 'system', content: '你是 Assistant' },
      { role: 'user', content: '查一下代码' },
      { role: 'assistant', content: '已派出 exe_a1，正在跑。' }, // 剔除
      { role: 'assistant', content: '共 3 个文件。' }, // 保留
      { role: 'user', content: '再查一个' },
      { role: 'assistant', content: '已派出，两个都在跑。' }, // 剔除
      { role: 'assistant', content: '完成。' }, // 保留
    ];
    const out = sanitizeSpawnClaims(msgs);
    assert.equal(out.length, 5);
    assert.ok(!out.some((m) => m.content?.includes('已派出')));
    assert.ok(out.some((m) => m.content === '共 3 个文件。'));
  });
});

/**
 * 谎报检测不能靠动词表。
 *
 * ## 踩过的坑
 *
 * 2026-11-15 实测：修了 `reasoning_content` 之后，Assistant 终于"看起来"
 * 在派活了，但数据库里根本没有那条记录：
 *
 *   Assistant 说：已实际调用工具，Agent id `exe_mwi2d7m1q9b4x`
 *   数据库最新：  14:30 的 exe_mwhxlmc618wnpu（早 36 分钟）
 *   exe_mwi2d7m1q9b4x：不存在
 *
 * 原来的 `claimsSpawn` 要求"id 前 40 字符里有派出类动词"，
 * 而「已实际调用工具」不在动词表里 —— 逃过了检测。
 *
 * 每补一个动词，模型就换一种说法。所以改成：
 * **正文出现 exe_ id 就算声称，交给调用方核对**。
 */
describe('**谎报检测不依赖措辞**', () => {
  it('「已实际调用工具，Agent id …」要被抓到', () => {
    const ids = claimsSpawn('已实际调用工具，Agent id `exe_mwi2d7m1q9b4x`，状态 starting');
    assert.deepEqual(ids, ['exe_mwi2d7m1q9b4x']);
  });

  it('前面没有动词也要抓到', () => {
    assert.deepEqual(claimsSpawn('Agent id exe_abc999，状态 starting'), ['exe_abc999']);
  });

  it('只有 id 也抓到', () => {
    assert.deepEqual(claimsSpawn('exe_abc999 正在跑'), ['exe_abc999']);
  });

  it('同一 id 重复只算一次', () => {
    const ids = claimsSpawn('exe_abc 和 exe_abc 是同一个');
    assert.deepEqual(ids, ['exe_abc']);
  });

  it('**否定陈述不算声称**（陈述事实不是派活）', () => {
    assert.deepEqual(claimsSpawn('数据库里没有 exe_abc 这条记录'), []);
    assert.deepEqual(claimsSpawn('exe_xyz 不存在'), []);
    assert.deepEqual(claimsSpawn('查不到 exe_xyz'), []);
  });
});

/**
 * 上下文健康检查：污染太重时整段清洗。
 *
 * ## 实测数据（2026-11-15 用户的库）
 *
 * 老项目一个会话 144 条消息：
 *
 *   49 条含 exe_ 的 assistant（谎报/样板）
 *   11 条「不成立」更正
 *   30 条 internal 系统注入（重试指令）
 *
 * —— 大部分上下文是修补机制自己制造的噪音。
 * 模型看到这串"说得像、做得不像"的先例，就不调工具了。
 *
 * **开新项目一次就成功**，证实是这个原因。
 */
describe('污染比例判定', () => {
  it('偶尔一条不清（每轮都清会失去连续感）', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 40; i += 1) {
      msgs.push({ role: 'assistant', content: `第 ${i} 条正常回复。` });
    }
    msgs.push({ role: 'assistant', content: '已派出 exe_x123。' });
    const cleaned = sanitizeSpawnClaims(msgs);
    const removed = msgs.length - cleaned.length;
    assert.equal(removed, 1);
    assert.ok(removed / msgs.length < 0.25, '1/41 不该触发整段清洗');
  });

  it('**大规模污染要触发清洗**（复刻真实会话）', () => {
    const msgs: Msg[] = [];
    for (let i = 0; i < 49; i += 1) {
      msgs.push({ role: 'assistant', content: `已派出 exe_fake${i}，正在跑。` });
      msgs.push({ role: 'user', content: `第 ${i} 个任务` });
      msgs.push({ role: 'assistant', content: `完成 ${i}。` });
    }
    const cleaned = sanitizeSpawnClaims(msgs);
    const removed = msgs.length - cleaned.length;
    assert.equal(removed, 49, '49 条谎报样板都该清掉');
    assert.ok(removed > 10, '超过 10 条，触发整段清洗');
  });
});

/**
 * **承诺式**说法也要抓。
 *
 * ## 2026-11-16 用户实测（C1）
 *
 * > Assistant 说会重新派一个 Agent 来完成，但也没有派
 *
 * 它说的是**将来时**（"我会重新派一个"），不是"已派出"，
 * 所以原来的规则全漏了。但对用户来说效果一样：
 * 被告知会有动作，实际没有。
 */
describe('**承诺式说法**', () => {
  it('「我会重新派一个 Agent」要抓到', () => {
    assert.equal(claimsSpawnWithoutId('我会重新派一个 Agent 来完成'), true);
  });

  it('「我这就派一个」要抓到', () => {
    assert.equal(claimsSpawnWithoutId('我这就派一个 Agent 去修'), true);
  });

  it('「马上派一个」「重新派一个」「再派一个」都算', () => {
    for (const t of ['马上派一个 Agent', '重新派一个 Agent', '再派一个 Agent 处理']) {
      assert.equal(claimsSpawnWithoutId(t), true, ` 没抓到`);
    }
  });

  it('**「派一个 Agent 去查」是指令，不是承诺**', () => {
    // 这是用户在说，不是 Assistant 在承诺。不能误判。
    assert.equal(claimsSpawnWithoutId('派一个 Agent 去查日志'), false);
  });

  it('普通回答不误判', () => {
    for (const t of ['这个问题的答案是 42', '我看了代码，问题在缓存']) {
      assert.equal(claimsSpawnWithoutId(t), false, ` 被误判`);
    }
  });
});