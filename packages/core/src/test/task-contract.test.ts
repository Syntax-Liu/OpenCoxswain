import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskContract } from '../task-contract.js';
import { validContract } from './helpers.js';

test('合法任务单通过校验', () => {
  const result = validateTaskContract(validContract());
  assert.equal(result.ok, true);
});

test('缺少必填字段被拒绝', () => {
  const result = validateTaskContract({ ...validContract(), goal: '' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.includes('goal')));
});

test('command 验收必须提供 check', () => {
  const result = validateTaskContract(
    validContract({
      acceptance_criteria: [{ id: 'ac1', type: 'command', desc: '跑测试' }],
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.some((error) => error.includes('check')));
});

test('验收标准 id 不能重复', () => {
  const result = validateTaskContract(
    validContract({
      acceptance_criteria: [
        { id: 'ac1', type: 'human', desc: '一' },
        { id: 'ac1', type: 'human', desc: '二' },
      ],
    }),
  );
  assert.equal(result.ok, false);
});

test('预算至少需要一项正数', () => {
  const result = validateTaskContract(validContract({ budget: {} }));
  assert.equal(result.ok, false);
});
