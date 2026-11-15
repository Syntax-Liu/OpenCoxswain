/**
 * 等待状态测试。
 *
 * 核心约束：**文案要说对在等什么**。
 * 有 Agent 在跑时等的是 Agent，不是模型——说错会让人以为卡住了。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SLOW_MS,
  STALLED_MS,
  describeWait,
  estimateTypicalDuration,
  formatElapsed,
  waitLevel,
} from '../components/waitStatus.js';

describe('时长格式化', () => {
  it('不足一分钟显示秒', () => {
    assert.equal(formatElapsed(12_000), '12 秒');
  });

  it('超过一分钟显示分秒', () => {
    assert.equal(formatElapsed(80_000), '1 分 20 秒');
  });

  it('整分钟不显示 0 秒', () => {
    assert.equal(formatElapsed(120_000), '2 分');
  });

  it('负数按 0 处理', () => {
    assert.equal(formatElapsed(-5000), '0 秒');
  });
});

describe('档位', () => {
  it('刚发出是正常', () => {
    assert.equal(waitLevel(1000), 'normal');
  });

  it('超过 15 秒变慢', () => {
    assert.equal(waitLevel(SLOW_MS), 'slow');
  });

  it('超过 45 秒算卡顿', () => {
    assert.equal(waitLevel(STALLED_MS), 'stalled');
  });

  it('阈值边界正确（-1 毫秒仍是上一档）', () => {
    assert.equal(waitLevel(SLOW_MS - 1), 'normal');
    assert.equal(waitLevel(STALLED_MS - 1), 'slow');
  });
});

describe('没有 Agent 在跑（等模型）', () => {
  it('正常档说"正在等模型响应"', () => {
    const s = describeWait(3000);
    assert.equal(s.level, 'normal');
    assert.match(s.text, /正在等模型响应/);
    assert.match(s.text, /3 秒/);
  });

  it('慢档说明还在等，不要让人以为挂了', () => {
    const s = describeWait(20_000);
    assert.equal(s.level, 'slow');
    assert.match(s.text, /还在等/);
  });

  it('**卡顿档给出可执行的动作**', () => {
    const s = describeWait(60_000);
    assert.equal(s.level, 'stalled');
    assert.match(s.text, /停止/);
  });
});

describe('有 Agent 在跑', () => {
  it('**等的是 Agent，不是模型**', () => {
    const s = describeWait(5000, { runningAgents: 3 });
    assert.match(s.text, /3 个 Agent/);
    assert.ok(!s.text.includes('模型'), '不该说在等模型');
  });

  it('显示已跑多久', () => {
    const s = describeWait(40_000, { runningAgents: 2 });
    assert.match(s.text, /40 秒/);
  });

  it('单数也说得通（1 个 Agent）', () => {
    const s = describeWait(5000, { runningAgents: 1 });
    assert.match(s.text, /1 个 Agent/);
  });

  it('卡顿时提示可以等也可以停', () => {
    const s = describeWait(90_000, { runningAgents: 2 });
    assert.equal(s.level, 'stalled');
    assert.match(s.text, /继续等/);
    assert.match(s.text, /停止/);
  });
});

describe('典型耗时估算', () => {
  it('**样本不足 2 个时返回 null**（不构成规律）', () => {
    assert.equal(estimateTypicalDuration([]), null);
    assert.equal(estimateTypicalDuration([5000]), null);
  });

  it('两个样本取平均', () => {
    assert.equal(estimateTypicalDuration([10_000, 20_000]), 15_000);
  });

  it('奇数样本取中位', () => {
    assert.equal(estimateTypicalDuration([10_000, 20_000, 30_000]), 20_000);
  });

  it('忽略非正数', () => {
    assert.equal(estimateTypicalDuration([0, -5, 10_000, 20_000]), 15_000);
  });
});
