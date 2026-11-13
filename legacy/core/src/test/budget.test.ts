import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCost, evaluateBudget, sumBudgets } from '../budget.js';

test('70% 触发警告', () => {
  const result = evaluateBudget({ usd: 2 }, { ...emptyCost(), usd: 1.4 });
  assert.equal(result.status, 'warning');
});

test('100% 触发硬停', () => {
  const result = evaluateBudget({ tokens: 1000 }, { ...emptyCost(), tokensIn: 600, tokensOut: 400 });
  assert.equal(result.status, 'exceeded');
});

test('未设置上限时正常', () => {
  const result = evaluateBudget({}, emptyCost());
  assert.equal(result.status, 'ok');
});

test('预算求和', () => {
  assert.deepEqual(sumBudgets([{ usd: 1, tokens: 10 }, { usd: 2, minutes: 5 }]), {
    usd: 3,
    tokens: 10,
    minutes: 5,
  });
});
