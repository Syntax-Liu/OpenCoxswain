import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
