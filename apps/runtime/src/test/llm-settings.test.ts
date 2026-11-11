/**
 * 模型密钥保管测试。
 *
 * 这个功能的出发点很具体：桌面应用双击启动时没有终端，
 * 用户不可能先设环境变量再用。所以必须能保存到文件、且保存后立即生效。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { DEFAULT_BASE_URL, DEFAULT_MODEL, LlmProvider, LlmSettingsStore } from '../llm/settings.js';

const temps: string[] = [];
const savedEnv = { ...process.env };

after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  // 还原环境变量，避免测试之间相互影响
  for (const key of ['OPENCOXSWAIN_LLM_API_KEY', 'DEEPSEEK_API_KEY', 'OPENCOXSWAIN_LLM_BASE_URL', 'OPENCOXSWAIN_LLM_MODEL']) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function makeStore(): Promise<LlmSettingsStore> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-llm-'));
  temps.push(dir);
  // 清掉环境变量，确保走文件路径
  delete process.env.OPENCOXSWAIN_LLM_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  return new LlmSettingsStore({ file: path.join(dir, 'llm.json') });
}

describe('密钥状态', () => {
  it('什么都没配时 configured=false', async () => {
    const store = await makeStore();
    const status = await store.status();
    assert.equal(status.configured, false);
    assert.equal(status.source, 'none');
    assert.equal(status.baseUrl, DEFAULT_BASE_URL);
    assert.equal(status.model, DEFAULT_MODEL);
  });

  it('保存后 configured=true，来源是 file', async () => {
    const store = await makeStore();
    await store.save({ apiKey: 'sk-test-123456', baseUrl: '', model: '' });
    const status = await store.status();
    assert.equal(status.configured, true);
    assert.equal(status.source, 'file');
    // 空值回落到默认
    assert.equal(status.baseUrl, DEFAULT_BASE_URL);
    assert.equal(status.model, DEFAULT_MODEL);
  });

  it('环境变量优先于文件', async () => {
    const store = await makeStore();
    await store.save({ apiKey: 'sk-from-file', baseUrl: '', model: '' });

    process.env.OPENCOXSWAIN_LLM_API_KEY = 'sk-from-env';
    try {
      const status = await store.status();
      assert.equal(status.configured, true);
      assert.equal(status.source, 'env');

      const resolved = await store.resolve();
      assert.equal(resolved?.apiKey, 'sk-from-env');
    } finally {
      delete process.env.OPENCOXSWAIN_LLM_API_KEY;
    }
  });

  it('清除后回到未配置', async () => {
    const store = await makeStore();
    await store.save({ apiKey: 'sk-x', baseUrl: '', model: '' });
    await store.clear();
    assert.equal((await store.status()).configured, false);
  });

  it('拒绝空密钥', async () => {
    const store = await makeStore();
    await assert.rejects(() => store.save({ apiKey: '   ', baseUrl: '', model: '' }), /不能为空/);
  });
});

describe('密钥落盘', () => {
  it('写进指定的文件，且是合法 JSON（便于用户手工编辑）', async () => {
    const store = await makeStore();
    await store.save({ apiKey: 'sk-abc', baseUrl: 'https://example.com/v1', model: 'm1' });

    const raw = await readFile(store.file, 'utf8');
    const parsed = JSON.parse(raw) as { apiKey: string; baseUrl: string; model: string };
    assert.equal(parsed.apiKey, 'sk-abc');
    assert.equal(parsed.baseUrl, 'https://example.com/v1');
    assert.equal(parsed.model, 'm1');
  });

  it('文件损坏时视为未配置，而不是抛异常', async () => {
    const store = await makeStore();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(store.file), { recursive: true });
    await writeFile(store.file, 'not json at all', 'utf8');
    assert.equal(await store.read(), null);
    assert.equal((await store.status()).configured, false);
  });
});

describe('LlmProvider：保存后立即生效', () => {
  it('未配置时 chat 给出可读错误，而不是空指针', async () => {
    const store = await makeStore();
    const provider = new LlmProvider(store);
    await provider.refresh();

    assert.equal(provider.ready, false);
    await assert.rejects(
      () => provider.chat({ messages: [], tools: [], signal: new AbortController().signal }),
      /尚未配置模型密钥/,
    );
  });

  it('保存密钥后 refresh 即就绪，无需重建 provider', async () => {
    const store = await makeStore();
    const provider = new LlmProvider(store);
    await provider.refresh();
    assert.equal(provider.ready, false);

    await store.save({ apiKey: 'sk-live', baseUrl: '', model: '' });
    const ready = await provider.refresh();

    assert.equal(ready, true);
    assert.equal(provider.ready, true);
  });
});
