import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeSpawnClaims } from '../assistant/spawnClaim.js';

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
