import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Handback：Agent 主动交回任务。
 *
 * ## 对齐 DSH
 *
 * DSH 的决定有四种：accept / stop / ignore / **unavailable**。
 * Handback 是 `unavailable` 的具体形态——执行器说"这活不归我干"。
 *
 * ## 为什么不能算 failed
 *
 * 原来这三种情况都落在 `failed` 里：
 *
 *   1. 真出错（OOM、网络断、代码崩）
 *   2. 不知道怎么做（指令不清）
 *   3. **判断出这活不归我干**
 *
 * 用户看到"失败"必须点进去才知道是哪一种。而第 3 种其实是
 * **Agent 干对了**——它发现了问题的真正所在。
 *
 * 调研类 Agent 尤其常遇到：让查登录问题，查出来是连接池配错。
 * 这些宝贵的发现原来都被当成失败淹没了。
 */
describe('**状态定义**', () => {
  it('runtime 有 handback 状态', () => {
    const src = readFileSync(new URL('../../src/store/store.ts', import.meta.url), 'utf8');
    assert.match(src, /'handback'/, '没定义 handback 状态');
  });

  it('**handback 是终态**（否则界面一直显示"运行中"）', () => {
    const src = readFileSync(new URL('../../src/store/store.ts', import.meta.url), 'utf8');
    const start = src.indexOf('EXECUTOR_TERMINAL');
    const block = src.slice(start, start + 400);
    assert.match(block, /handback/, 'handback 不在终态列表里');
  });

  it('web 有对应的中文标签', () => {
    const src = readFileSync(new URL('../../../web/src/state.ts', import.meta.url), 'utf8');
    assert.match(src, /handback:\s*'已交回'/, '没有"已交回"标签');
  });

  it('**不用 danger 色**（交回不是失败）', () => {
    const src = readFileSync(
      new URL('../../../web/src/components/semanticColor.ts', import.meta.url),
      'utf8',
    );
    const start = src.indexOf("case 'handback'");
    assert.ok(start > 0, '颜色表里没有 handback');
    const block = src.slice(start, start + 200);
    assert.ok(!block.includes("return 'danger'"), '交回不该用危险色');
  });
});

describe('**工具定义**', () => {
  const src = readFileSync(new URL('../../src/executor/executor.ts', import.meta.url), 'utf8');

  it('Agent 有 hand_back 工具', () => {
    assert.match(src, /name: 'hand_back'/, '没有 hand_back 工具');
  });

  it('**必须同时给 reason 和 findings**', () => {
    // 空着交回等于白干：Assistant 拿不到任何信息，还得重头查。
    assert.match(src, /required: \['reason', 'findings'\]/);
  });

  it('工具说明里要讲清"交回不是失败"', () => {
    const start = src.indexOf("name: 'hand_back'");
    const block = src.slice(start, start + 1200);
    assert.match(block, /不是失败/, '没说明交回不是失败');
  });
});

describe('**循环立即结束**', () => {
  const src = readFileSync(new URL('../../src/session/loop.ts', import.meta.url), 'utf8');

  it('runLoop 见到 handback 就 return', () => {
    assert.match(src, /if \(result\.handback\)/, '循环没处理 handback');
    const start = src.indexOf('if (result.handback)');
    const block = src.slice(start, start + 700);
    assert.match(block, /return;/, 'handback 后没有立刻结束循环');
  });

  it('**把 findings 当最终文本带出去**（查到的不能丢）', () => {
    const start = src.indexOf('if (result.handback)');
    const block = src.slice(start, start + 700);
    assert.match(block, /finalText:\s*hb\.findings/, 'findings 没带出去');
  });

  it('有 handback 事件类型', () => {
    assert.match(src, /readonly type: 'handback'/, '没有 handback 事件类型');
  });
});

describe('**结算不走成功/失败**', () => {
  const src = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('结算时先判断 handback', () => {
    assert.match(src, /const handback = outcome\.events\.find/, '结算没检查 handback');
  });

  it('标成 handback 而不是 failed', () => {
    assert.match(src, /finishExecutor\(ready\.id, 'handback'/, '没标成 handback');
  });

  it('**用 worker_attention 通知**（要决策的那种，不是汇报结果那种）', () => {
    const start = src.indexOf("if (status === 'handback')");
    assert.ok(start > 0, '没处理 handback 的通知');
    const block = src.slice(start, start + 900);
    assert.match(block, /makeTrigger\('worker_attention'/, '没用 attention 类型的通知');
  });
});

/**
 * **说了"交回"但没调工具**（2026-11-16 用户实测）。
 *
 * 实况：Agent 的最后一句是
 *
 *     **结论：分支 B —— `src/` 里没有任何登录 / 认证相关代码，
 *       因此不做任何修改，交回。**
 *
 * 但它**没有调用 `hand_back` 工具**，于是被记成 `done`。
 * Assistant 和用户都以为它做完了。
 *
 * 和"谎报已派出"是同一类问题：**文字不等于动作**。
 */
describe('**文字说交回也要被识别**', () => {
  const src = readFileSync(new URL('../../src/orchestrator.ts', import.meta.url), 'utf8');

  it('结算时检查文本里有没有"交回"', () => {
    assert.match(src, /claimsHandback/, '没有检查文字里的交回声明');
  });

  it('识别到就标成 handback', () => {
    const start = src.indexOf('claimsHandback');
    const block = src.slice(start, start + 900);
    assert.match(block, /'handback'/, '没有改成 handback 状态');
  });

  it('工具描述里强调"必须真的调用"', () => {
    const ex = readFileSync(new URL('../../src/executor/executor.ts', import.meta.url), 'utf8');
    const start = ex.indexOf("name: 'hand_back'");
    const block = ex.slice(start, start + 1500);
    assert.match(block, /光在回复里写/, '没强调光说没用');
  });
});