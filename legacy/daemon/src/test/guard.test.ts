import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAction } from '@opencoxswain/adapters';

test('危险动作识别：覆盖 PRD 五类动作', () => {
  assert.equal(classifyAction('bash', { command: 'git push origin main' }), 'push');
  assert.equal(classifyAction('bash', { command: 'rm -rf build' }), 'delete');
  assert.equal(classifyAction('bash', { command: 'pnpm publish --access public' }), 'publish');
  assert.equal(classifyAction('bash', { command: 'stripe charges create' }), 'pay');
  assert.equal(
    classifyAction('bash', { command: 'curl -X POST https://example.com/hook' }),
    'external_send',
  );
  assert.equal(classifyAction('git_push', { branch: 'main' }), 'push');
});

test('危险动作识别：普通读写不误判', () => {
  assert.equal(classifyAction('read', { path: 'README.md' }), null);
  assert.equal(
    classifyAction('file_write', { path: 'docs/a.md', content: '示例：git push origin main' }),
    null,
  );
});
