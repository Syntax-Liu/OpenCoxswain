import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../app.js';
import { DpapiVault } from '../secrets.js';

test(
  'DPAPI 密钥仓库：密文落盘且可读回',
  { skip: process.platform !== 'win32' },
  async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-secret-'));
    try {
      const vault = new DpapiVault(path.join(temp, 'secrets'));
      await vault.set('llm_api_key', 'sk-test-plaintext');
      assert.equal(await vault.get('llm_api_key'), 'sk-test-plaintext');
      assert.equal(await vault.source('llm_api_key'), 'vault');

      const cipher = await readFile(path.join(temp, 'secrets', 'llm_api_key.bin'));
      assert.equal(cipher.includes(Buffer.from('sk-test-plaintext')), false, '明文不落盘');

      await vault.remove('llm_api_key');
      assert.equal(await vault.get('llm_api_key'), null);
      assert.equal(await vault.source('llm_api_key'), 'none');
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

test('设置页保存密钥：CORS 预检必须放行 PUT 与 DELETE', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-secret-'));
  const app = await startDaemon({
    homeDir: temp,
    dbPath: path.join(temp, 'test.db'),
    worktreesDir: path.join(temp, 'worktrees'),
    artifactsDir: path.join(temp, 'artifacts'),
    port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/secrets/llm`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const allowed = response.headers.get('access-control-allow-methods') ?? '';
    assert.match(allowed, /PUT/, '桌面端 PUT 保存密钥不能被预检拦下');
    assert.match(allowed, /DELETE/, '删除密钥同样依赖 DELETE');
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('密钥缺失时回退环境变量', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-secret-'));
  const previous = process.env.OPENCOXSWAIN_LLM_API_KEY;
  try {
    process.env.OPENCOXSWAIN_LLM_API_KEY = 'env-only-key';
    const vault = new DpapiVault(path.join(temp, 'secrets'));
    assert.equal(await vault.get('llm_api_key'), 'env-only-key');
    assert.equal(await vault.source('llm_api_key'), 'env');
  } finally {
    if (previous === undefined) delete process.env.OPENCOXSWAIN_LLM_API_KEY;
    else process.env.OPENCOXSWAIN_LLM_API_KEY = previous;
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
