/**
 * 批次测试。
 *
 * 批次是本产品的签名元素——把「一句话派多个 Agent、谁先完成谁先报」
 * 变成看得见的结构。这组测试守三件事：
 * 1. 同一轮派的归为一批
 * 2. 隔太久的不会被误合并
 * 3. **完成的排前面**（这是产品承诺在界面上的体现）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutorDto } from '../api.js';
import {
  BATCH_WINDOW_MS,
  describeBatch,
  formatShortDuration,
  groupBatches,
  isNotableBatch,
  toTaskLine,
} from '../components/batches.js';

function agent(over: Partial<ExecutorDto> & { id: string; createdAt: number }): ExecutorDto {
  return {
    projectId: 'p1',
    sessionId: 's1',
    label: over.id,
    goal: 'g',
    access: 'readwrite',
    writeScope: [],
    status: 'done',
    summary: null,
    blockedReason: null,
    metrics: { turns: 0, steps: 0, tokensIn: 0, tokensOut: 0, cachedTokens: null, durationMs: 0, contextTokens: null },
    criteria: [],
    policy: 'unverified_only',
    acceptance: null,
    endedAt: null,
    ...over,
  } as ExecutorDto;
}

describe('批次聚类', () => {
  it('同一时间窗内的归为一批', () => {
    const batches = groupBatches([
      agent({ id: 'a', createdAt: 1000 }),
      agent({ id: 'b', createdAt: 3000 }),
      agent({ id: 'c', createdAt: 5000 }),
    ]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.agents.length, 3);
  });

  it('**间隔超过窗口就分成两批**', () => {
    const batches = groupBatches([
      agent({ id: 'a', createdAt: 1000 }),
      agent({ id: 'b', createdAt: 1000 + BATCH_WINDOW_MS + 1 }),
    ]);
    assert.equal(batches.length, 2);
  });

  it('空列表返回空数组', () => {
    assert.deepEqual(groupBatches([]), []);
  });

  it('乱序输入也能正确聚类', () => {
    const batches = groupBatches([
      agent({ id: 'b', createdAt: 3000 }),
      agent({ id: 'a', createdAt: 1000 }),
    ]);
    assert.equal(batches.length, 1);
  });
});

describe('批次内排序（谁先完成谁在上）', () => {
  it('**已完成的排在进行中的前面**', () => {
    const batches = groupBatches([
      agent({ id: 'running', createdAt: 1000, status: 'running', endedAt: null }),
      agent({ id: 'done', createdAt: 2000, status: 'done', endedAt: 5000 }),
    ]);
    assert.equal(batches[0]?.agents[0]?.id, 'done', '完成的应该在第一个');
  });

  it('都在完成状态时，先完成的在上', () => {
    const batches = groupBatches([
      agent({ id: 'late', createdAt: 1000, status: 'done', endedAt: 9000 }),
      agent({ id: 'early', createdAt: 2000, status: 'done', endedAt: 3000 }),
    ]);
    assert.equal(batches[0]?.agents[0]?.id, 'early');
  });

  it('排队的在最后', () => {
    const batches = groupBatches([
      agent({ id: 'starting', createdAt: 1000, status: 'starting', endedAt: null }),
      agent({ id: 'done', createdAt: 2000, status: 'done', endedAt: 3000 }),
    ]);
    assert.equal(batches[0]?.agents[0]?.id, 'done');
    assert.equal(batches[0]?.agents[1]?.id, 'starting');
  });
});

describe('任务行状态', () => {
  it('starting 显示为排队', () => {
    assert.equal(toTaskLine(agent({ id: 'x', createdAt: 0, status: 'starting', endedAt: null })).status, 'queued');
  });

  it('running 显示为进行中', () => {
    assert.equal(toTaskLine(agent({ id: 'x', createdAt: 0, status: 'running', endedAt: null })).status, 'running');
  });

  it('有结束时间就是完成', () => {
    const line = toTaskLine(agent({ id: 'x', createdAt: 1000, status: 'done', endedAt: 61000 }));
    assert.equal(line.status, 'done');
    assert.equal(line.duration, '1:00');
  });

  it('未结束没有时长', () => {
    assert.equal(toTaskLine(agent({ id: 'x', createdAt: 0, status: 'running', endedAt: null })).duration, null);
  });
});

describe('时长格式', () => {
  it('分:秒', () => {
    assert.equal(formatShortDuration(0, 51_000), '0:51');
    assert.equal(formatShortDuration(0, 134_000), '2:14');
  });

  it('超过一小时带小时', () => {
    assert.equal(formatShortDuration(0, 3_723_000), '1:02:03');
  });

  it('负数不出错', () => {
    assert.equal(formatShortDuration(1000, 500), '0:00');
  });
});

describe('批次描述', () => {
  it('全部完成时说明', () => {
    const batches = groupBatches([
      agent({ id: 'a', createdAt: 1000, status: 'done', endedAt: 2000 }),
      agent({ id: 'b', createdAt: 2000, status: 'done', endedAt: 3000 }),
    ]);
    assert.match(describeBatch(batches[0]!).summary, /全部完成/);
  });

  it('部分完成时报进度', () => {
    const batches = groupBatches([
      agent({ id: 'a', createdAt: 1000, status: 'done', endedAt: 2000 }),
      agent({ id: 'b', createdAt: 2000, status: 'running', endedAt: null }),
    ]);
    assert.match(describeBatch(batches[0]!).summary, /1 个已完成/);
  });
});

describe('哪些批次值得画线', () => {
  it('**只派一个不画批次线**（那是普通派活）', () => {
    const batches = groupBatches([agent({ id: 'a', createdAt: 1000 })]);
    assert.equal(isNotableBatch(batches[0]!), false);
  });

  it('两个以上才画', () => {
    const batches = groupBatches([
      agent({ id: 'a', createdAt: 1000 }),
      agent({ id: 'b', createdAt: 2000 }),
    ]);
    assert.equal(isNotableBatch(batches[0]!), true);
  });
});
