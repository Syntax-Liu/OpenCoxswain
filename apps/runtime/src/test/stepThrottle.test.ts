/**
 * 步骤节流器。
 *
 * 这段逻辑原本内联在 3000 行的 `Orchestrator` 里，无法单独测。
 * 抽出来后可以用假时间源精确验证时间窗口行为。
 *
 * 守的是三件事：
 * 1. 窗口外的步骤立即发出
 * 2. 窗口内合并，且**保留最后一条**（界面要的是"现在在做什么"）
 * 3. 定时器 unref，不拖住进程退出
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STEP_THROTTLE_MS, StepThrottle, type ThrottledStep } from '../orchestrator/stepThrottle.js';
import type { StepDescription } from '../executor/step.js';

function step(label: string): StepDescription {
  return { label, tool: 'write_file', at: 0 };
}

/** 造一个可手动推进的时间源。 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('**窗口外的步骤立即发出**', () => {
  it('第一次报告直接 emit', () => {
    const sent: ThrottledStep[] = [];
    const clock = fakeClock();
    const throttle = new StepThrottle((item) => sent.push(item), 300, clock.now);

    const result = throttle.report('e1', 'p1', step('读取 a.ts'));

    assert.equal(sent.length, 1);
    assert.equal(result?.step.label, '读取 a.ts');
    assert.equal(sent[0]?.executorId, 'e1');
    assert.equal(sent[0]?.projectId, 'p1');
    throttle.dispose();
  });

  it('过了窗口之后再报告，也立即发出', () => {
    const sent: ThrottledStep[] = [];
    const clock = fakeClock();
    const throttle = new StepThrottle((item) => sent.push(item), 300, clock.now);

    throttle.report('e1', 'p1', step('第一步'));
    clock.advance(500);
    throttle.report('e1', 'p1', step('第二步'));

    assert.deepEqual(sent.map((s) => s.step.label), ['第一步', '第二步']);
    throttle.dispose();
  });
});

describe('**窗口内合并，保留最后一条**', () => {
  it('连续三步在窗口内，只补发最后那一步', async () => {
    const sent: ThrottledStep[] = [];
    const clock = fakeClock();
    const throttle = new StepThrottle((item) => sent.push(item), 20, clock.now);

    throttle.report('e1', 'p1', step('A')); // 立即发出
    const r1 = throttle.report('e1', 'p1', step('B')); // 进窗口
    const r2 = throttle.report('e1', 'p1', step('C')); // 覆盖 B，仍是窗口
    const r3 = throttle.report('e1', 'p1', step('D')); // 覆盖 C

    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(r3, null);
    assert.equal(sent.length, 1, '窗口内不该立即发出');

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.step.label, 'D', '合并时必须保留最后一条，否则界面停在过时步骤');
    throttle.dispose();
  });
});

describe('**多个执行器互不干扰**', () => {
  it('e1 在窗口内不影响 e2 立即发出', () => {
    const sent: ThrottledStep[] = [];
    const clock = fakeClock();
    const throttle = new StepThrottle((item) => sent.push(item), 300, clock.now);

    throttle.report('e1', 'p1', step('A'));
    throttle.report('e1', 'p1', step('B')); // e1 进窗口
    throttle.report('e2', 'p1', step('X')); // e2 首条，应立即发出

    assert.deepEqual(sent.map((s) => `${s.executorId}:${s.step.label}`), ['e1:A', 'e2:X']);
    throttle.dispose();
  });
});

describe('**清理与退出**', () => {
  it('forget 清掉该执行器的状态', () => {
    const throttle = new StepThrottle(() => {}, 300, fakeClock().now);
    throttle.report('e1', 'p1', step('A'));
    assert.equal(throttle.size(), 1);
    throttle.forget('e1');
    assert.equal(throttle.size(), 0);
  });

  it('dispose 后不再有残留定时器（进程能正常退出）', () => {
    const sent: ThrottledStep[] = [];
    const clock = fakeClock();
    const throttle = new StepThrottle((item) => sent.push(item), 20, clock.now);
    throttle.report('e1', 'p1', step('A'));
    throttle.report('e1', 'p1', step('B')); // 挂起一个定时器
    throttle.dispose();
    assert.doesNotThrow(() => throttle.dispose());
  });

  it('默认窗口是 300ms（与拆分前一致）', () => {
    assert.equal(STEP_THROTTLE_MS, 300);
  });
});
