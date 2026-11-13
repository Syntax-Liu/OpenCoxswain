import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../summary.js';
import { validContract } from './helpers.js';

test('汇总固定三块', () => {
  const summary = buildSummary({
    contract: validContract(),
    status: 'awaiting_review',
    acceptance: [{ criterionId: 'ac1', status: 'passed', judgedBy: 'system' }],
    artifacts: [{ type: 'diff', path: 'artifacts/tsk_01/diff.patch', meta: { files: 3, additions: 48, deletions: 12 } }],
    cost: { tokensIn: 9000, tokensOut: 2000, usd: 0.42, minutes: 3 },
    branch: 'opencoxswain/tsk_01',
  });
  assert.match(summary, /## 待你决策/);
  assert.match(summary, /## 未通过的检查/);
  assert.match(summary, /## 交付产物/);
  assert.match(summary, /ac2/);
  assert.match(summary, /opencoxswain\/tsk_01/);
});

test('失败检查带证据', () => {
  const summary = buildSummary({
    contract: validContract(),
    status: 'awaiting_review',
    acceptance: [
      { criterionId: 'ac1', status: 'failed', evidence: 'exit 1', judgedBy: 'system' },
      { criterionId: 'ac2', status: 'unverified', judgedBy: 'human' },
    ],
    artifacts: [],
    cost: { tokensIn: 1, tokensOut: 1, usd: 0.01, minutes: 0.1 },
  });
  assert.match(summary, /\[x\] ac1/);
  assert.match(summary, /exit 1/);
  assert.match(summary, /\[ \] ac2/);
});
