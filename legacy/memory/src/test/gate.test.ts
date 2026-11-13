import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCandidate, normalizeText, tokenize } from '../index.js';

test('中文按二元组切分，西文按单词切分', () => {
  const tokens = tokenize('使用 pnpm 构建 night-mode');
  assert.ok(tokens.includes('使用'));
  assert.ok(tokens.includes('pnpm'));
  assert.ok(tokens.includes('night-mode'));
  assert.ok(!tokens.includes('用 p'));
});

test('写入门槛：拒绝临时指令、密钥与过短内容', () => {
  assert.match(checkCandidate({ kind: 'profile', text: '这次先不用测试', source: 'user' }) ?? '', /临时/);
  assert.match(
    checkCandidate({ kind: 'profile', text: 'API Key 是 sk-abcdefghijklmnop', source: 'user' }) ?? '',
    /密钥/,
  );
  assert.match(checkCandidate({ kind: 'profile', text: '嗯', source: 'user' }) ?? '', /过短/);
  assert.match(checkCandidate({ kind: 'profile', text: '偏好 pnpm 工作区', source: ' ' }) ?? '', /来源/);
});

test('写入门槛：正常偏好可以通过', () => {
  assert.equal(
    checkCandidate({ kind: 'profile', text: '偏好 pnpm 工作区与 TypeScript strict', source: 'user:manual' }),
    null,
  );
});

test('文本归一化忽略大小写与空白差异', () => {
  assert.equal(normalizeText('  使用  PNPM   '), '使用 pnpm');
});
