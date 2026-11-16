import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { routeToSubscriber } from '../ticket/subscription.js';
import type { RunningExecutor } from '../ticket/subscription.js';

/**
 * Subscription：消息自动抵达正在跑的 Agent。
 *
 * ## 为什么需要（DSH docs/001-domain）
 *
 * > **订阅** — 匹配的触发会扇出给每一个存活的已订阅工单。
 * > 通过这种方式抵达工单的人的消息**不进入评估**。
 * > **被人停止的工单不接收任何内容。**
 *
 * 存在的原因：*后续讨论无需任何人再次 @ agent 就能抵达执行器。*
 *
 * ## 我们的痛点
 *
 * 派了一个 Agent，然后想说"再加个条件"——现在必须进 Agent 页面。
 * 在项目对话里说的话，Assistant 可能**又派一个新 Agent**，
 * 和原来的干重叠的活。
 */

const running = (id: string, label: string, status = 'running'): RunningExecutor => ({
  id,
  label,
  status,
});

describe('**唯一在跑 → 自动投递**', () => {
  it('投给那个 Agent', () => {
    const r = routeToSubscriber([running('exe_a', '统计文件')], '再加个条件：只统计 .md');
    assert.equal(r.kind, 'executor');
    if (r.kind === 'executor') assert.equal(r.executorId, 'exe_a');
  });

  it('starting 状态也算在跑', () => {
    const r = routeToSubscriber([running('exe_a', 'x', 'starting')], '补充一句');
    assert.equal(r.kind, 'executor');
  });

  it('原因里带上 label（方便在界面上说清投给了谁）', () => {
    const r = routeToSubscriber([running('exe_a', '统计文件')], '补充');
    assert.match(r.reason, /统计文件/);
  });
});

describe('**多个在跑 → 不猜**', () => {
  it('交给 Assistant 判断', () => {
    const r = routeToSubscriber(
      [running('exe_a', 'A'), running('exe_b', 'B')],
      '再加个条件',
    );
    assert.equal(r.kind, 'none');
    assert.match(r.reason, /2 个/);
  });

  it('**投错了比不投更糟**', () => {
    // 说清为什么不猜：投给错误的 Agent，它会照做，
    // 而真正该做的那个没收到——两边都错。
    const r = routeToSubscriber([running('a', 'A'), running('b', 'B')], '补充');
    assert.match(r.reason, /不明确/);
  });
});

describe('**没有在跑 → 正常流程**', () => {
  it('空列表', () => {
    assert.equal(routeToSubscriber([], '派个 Agent').kind, 'none');
  });

  it('**已停止的 Agent 不接收消息**（DSH 原规则）', () => {
    const r = routeToSubscriber([running('exe_a', 'A', 'cancelled')], '补充');
    assert.equal(r.kind, 'none', '被停止的工单不该再收消息');
  });

  it('done 的也不接收', () => {
    const r = routeToSubscriber([running('exe_a', 'A', 'done')], '补充');
    assert.equal(r.kind, 'none');
  });
});

describe('**要新任务时不加给旧 Agent**', () => {
  it('「再派一个 Agent」→ 不投递', () => {
    const r = routeToSubscriber([running('exe_a', 'A')], '再派一个 Agent 去查日志');
    assert.equal(r.kind, 'none');
    assert.match(r.reason, /新的事/);
  });

  it('「另外开个任务」→ 不投递', () => {
    const r = routeToSubscriber([running('exe_a', 'A')], '另外开个任务处理这个');
    assert.equal(r.kind, 'none');
  });

  it('**普通补充照常投递**（默认按补充处理）', () => {
    // 误判成新任务的代价是"想补充却被派了新 Agent"，
    // 所以默认保守地按补充处理。
    const r = routeToSubscriber([running('exe_a', 'A')], '记得把隐藏文件也算上');
    assert.equal(r.kind, 'executor');
  });
});

describe('边界', () => {
  it('空话也算补充（交给 Agent 自己理解）', () => {
    const r = routeToSubscriber([running('exe_a', 'A')], '   ');
    assert.equal(r.kind, 'executor');
  });

  it('多个中一个是 cancelled，只算一个活的', () => {
    const r = routeToSubscriber(
      [running('exe_a', 'A'), running('exe_b', 'B', 'cancelled')],
      '补充',
    );
    assert.equal(r.kind, 'executor');
    if (r.kind === 'executor') assert.equal(r.executorId, 'exe_a');
  });
});
