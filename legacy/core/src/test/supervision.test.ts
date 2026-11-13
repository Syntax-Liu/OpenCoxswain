import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRecord, Task, TaskContract, Worker } from '@opencoxswain/shared';
import {
  DEFAULT_SUPERVISION_THRESHOLDS,
  inspectSupervision,
  type SupervisionInput,
} from '../supervision.js';
import { validContract } from './helpers.js';

function taskWith(overrides: Partial<TaskContract> = {}): Task {
  return {
    id: 'tsk_01',
    projectId: 'prj_01',
    parentId: null,
    title: '修复夜间模式',
    goal: '切换夜间模式后立即生效',
    status: 'running',
    assigneeId: 'wrk_01',
    contract: validContract(overrides),
    createdAt: 1,
    updatedAt: 1,
  };
}

function workerWith(patch: Partial<Worker> = {}): Worker {
  return {
    id: 'wrk_01',
    taskId: 'tsk_01',
    role: 'implementer',
    runtime: 'mock',
    model: 'mock',
    worktreePath: '/tmp/wt',
    branch: 'opencoxswain/tsk_01',
    sessionRef: 'ses_01',
    status: 'running',
    cost: { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function event(index: number, type: string, payload: unknown, createdAt = 1000 + index): EventRecord {
  return { id: index, taskId: 'tsk_01', workerId: 'wrk_01', type, payload, createdAt };
}

function inputOf(
  events: EventRecord[],
  patch: Partial<SupervisionInput> = {},
): SupervisionInput {
  return {
    task: taskWith(),
    worker: workerWith(),
    recentEvents: events,
    now: 2000,
    startedAt: 1000,
    ...patch,
  };
}

test('监察：健康运行返回 ok', () => {
  const verdict = inspectSupervision(
    inputOf([event(1, 'runtime.tool_call', { tool: 'shell', input: { cmd: 'ls' } })]),
  );
  assert.equal(verdict.kind, 'ok');
});

test('监察：越权写入直接暂停', () => {
  const verdict = inspectSupervision(
    inputOf([
      event(1, 'runtime.tool_call', {
        tool: 'file_write',
        input: { path: 'secrets/key.txt' },
      }),
    ]),
  );
  assert.equal(verdict.kind, 'pause');
  if (verdict.kind === 'pause') assert.equal(verdict.rule, 'off_scope');
});

test('监察：空转完成判定失败', () => {
  const verdict = inspectSupervision(
    inputOf([
      event(
        1,
        'runtime.finished',
        { result: { summary: 'done', artifacts: [] } },
      ),
    ]),
  );
  assert.equal(verdict.kind, 'fail');
  if (verdict.kind === 'fail') assert.equal(verdict.rule, 'empty_completion');
});

test('监察：连续相同工具调用触发提示', () => {
  const call = { tool: 'shell', input: { cmd: 'npm test' } };
  const verdict = inspectSupervision(
    inputOf([
      event(1, 'runtime.tool_call', call),
      event(2, 'runtime.tool_call', call),
      event(3, 'runtime.tool_call', call),
    ]),
  );
  assert.equal(verdict.kind, 'nudge');
  if (verdict.kind === 'nudge') assert.equal(verdict.rule, 'repeated_fingerprint');
});

test('监察：连续工具调用没有产物触发停滞提示', () => {
  const events = Array.from({ length: DEFAULT_SUPERVISION_THRESHOLDS.stallToolCalls }, (_, index) =>
    event(index + 1, 'runtime.tool_call', { tool: 'shell', input: { cmd: `echo ${index}` } }),
  );
  const verdict = inspectSupervision(inputOf(events));
  assert.equal(verdict.kind, 'nudge');
  if (verdict.kind === 'nudge') assert.equal(verdict.rule, 'stalled');
});

test('监察：长时间无事件提示心跳', () => {
  const verdict = inspectSupervision(
    inputOf([event(1, 'runtime.tool_call', { tool: 'shell', input: { cmd: 'ls' } }, 1000)], {
      now: 1000 + DEFAULT_SUPERVISION_THRESHOLDS.noHeartbeatMs + 1,
    }),
  );
  assert.equal(verdict.kind, 'nudge');
  if (verdict.kind === 'nudge') assert.equal(verdict.rule, 'no_heartbeat');
});

test('监察：预算逼近上限与长尾都会提示', () => {
  const events = [event(1, 'runtime.tool_call', { tool: 'shell', input: { cmd: 'ls' } })];
  const budget = inspectSupervision(
    inputOf(events, {
      worker: workerWith({ cost: { tokensIn: 0, tokensOut: 0, usd: 1.7, minutes: 1 } }),
    }),
  );
  assert.equal(budget.kind, 'nudge');
  if (budget.kind === 'nudge') assert.equal(budget.rule, 'budget_slope');

  const longTailNow = 1000 + 30 * 60_000;
  const longTail = inspectSupervision(
    inputOf([event(1, 'runtime.tool_call', { tool: 'shell', input: { cmd: 'ls' } }, longTailNow - 500)], {
      now: longTailNow,
    }),
  );
  assert.equal(longTail.kind, 'nudge');
  if (longTail.kind === 'nudge') assert.equal(longTail.rule, 'long_tail');
});
