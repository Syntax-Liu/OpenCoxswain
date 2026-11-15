import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeTrigger, shouldWake, TRIGGER_WAKE } from '../orchestrator/trigger.js';
import type { TriggerKind } from '../orchestrator/trigger.js';

/**
 * Trigger：状态变化驱动的唤醒。
 *
 * ## 对齐 DSH 的设计
 *
 * DSH Super-Agent 的架构文档把投递给主 Session 的消息分两类：
 *
 *   会被引导到主 Session 的轮次中：  follow_up、worker_report
 *   不唤醒（只注入）：               ticket_ended、settings_saved、提示词保存…
 *
 * **这个区分是核心**：同样是"状态改变了"，有的要模型处理，有的只是留档。
 *
 * ## 我们踩过的坑（2026-11-15）
 *
 * 用户："Agent 跑完了，Assistant 没有及时汇报结果"。
 *
 * 根因是我们**所有状态变化都走同一条路**，于是"该汇报"和"该派活"
 * 混在一轮里，谎报重试一来，汇报就被顶掉了。
 */

describe('唤醒策略表', () => {
  it('**用户说话必须唤醒**', () => {
    assert.equal(TRIGGER_WAKE.user_message, true);
  });

  it('**Agent 完成必须唤醒**（这是"没汇报"的教训）', () => {
    assert.equal(TRIGGER_WAKE.worker_report, true);
  });

  it('**Agent 失败必须唤醒**（用户得知道）', () => {
    assert.equal(TRIGGER_WAKE.worker_failed, true);
  });

  it('**Agent 卡住必须唤醒**（要用户拍板）', () => {
    assert.equal(TRIGGER_WAKE.worker_attention, true);
  });

  it('**Agent 开始跑不唤醒**（侧栏已经会变，省一次模型调用）', () => {
    assert.equal(TRIGGER_WAKE.worker_started, false);
  });

  it('**取消不唤醒**（是用户自己按的，不用再跟他说一遍）', () => {
    assert.equal(TRIGGER_WAKE.worker_cancelled, false);
  });

  it('**配置变更不唤醒**', () => {
    assert.equal(TRIGGER_WAKE.settings_changed, false);
  });
});

describe('makeTrigger', () => {
  it('wake 自动按表填', () => {
    assert.equal(makeTrigger('worker_report').wake, true);
    assert.equal(makeTrigger('worker_started').wake, false);
  });

  it('带上 text 和 executorId', () => {
    const t = makeTrigger('worker_report', { text: '完成', executorId: 'exe_a' });
    assert.equal(t.text, '完成');
    assert.equal(t.executorId, 'exe_a');
  });

  it('不给的可选字段不写（不污染对象）', () => {
    const t = makeTrigger('worker_started');
    assert.equal('text' in t, false);
    assert.equal('executorId' in t, false);
  });
});

describe('shouldWake', () => {
  it('按表决定的返回 true', () => {
    assert.equal(shouldWake(makeTrigger('worker_report', { text: '完成' })), true);
  });

  it('按表决定的返回 false', () => {
    assert.equal(shouldWake(makeTrigger('worker_started', { text: '开始了' })), false);
  });

  it('**wake=true 但没内容 → 不唤醒**（唤醒它也没东西可说）', () => {
    assert.equal(shouldWake(makeTrigger('worker_report')), false);
  });

  it('**空白内容也不算**', () => {
    assert.equal(shouldWake(makeTrigger('worker_report', { text: '   \n  ' })), false);
  });
});

describe('表的完整性', () => {
  it('每个 kind 都有明确决定（不靠默认值猜）', () => {
    const kinds: TriggerKind[] = [
      'user_message',
      'worker_report',
      'worker_attention',
      'worker_cancelled',
      'worker_failed',
      'worker_started',
      'approval_rejected',
      'settings_changed',
      'schedule_fired',
      'im_message',
    ];
    for (const k of kinds) {
      assert.equal(typeof TRIGGER_WAKE[k], 'boolean', `${k} 没有明确决定`);
    }
  });
});
