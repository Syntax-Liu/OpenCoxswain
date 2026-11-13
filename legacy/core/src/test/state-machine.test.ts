import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canPause,
  canTransition,
  fromPaused,
  InvalidTransitionError,
  assertTransition,
  toPaused,
} from '../state-machine.js';

test('只有用户能把任务从待审批推进到队列', () => {
  assert.equal(canTransition('awaiting_approval', 'queued', 'user'), true);
  assert.equal(canTransition('awaiting_approval', 'queued', 'scheduler'), false);
});

test('员工不能推进任务状态', () => {
  assert.equal(canTransition('running', 'awaiting_review', 'worker'), false);
  assert.equal(canTransition('running', 'awaiting_review', 'scheduler'), true);
});

test('验收结论齐全时调度器可直接置 done，但用户验收仍独占 awaiting_review -> done', () => {
  assert.equal(canTransition('running', 'done', 'scheduler'), true);
  assert.equal(canTransition('running', 'done', 'worker'), false);
});

test('只有用户能最终验收 done', () => {
  assert.equal(canTransition('awaiting_review', 'done', 'scheduler'), false);
  assert.equal(canTransition('awaiting_review', 'done', 'user'), true);
});

test('暂停与恢复保持前置状态', () => {
  assert.equal(canPause('running'), true);
  assert.equal(toPaused('running'), 'paused');
  assert.equal(fromPaused('running'), 'running');
  assert.equal(canPause('done'), false);
});

test('非法迁移抛出明确错误', () => {
  assert.throws(
    () => assertTransition('done', 'running', 'user'),
    (error: unknown) => error instanceof InvalidTransitionError,
  );
});
