/**
 * 密钥加密测试。
 *
 * 重点：
 * 1. 有加密服务时，**磁盘上不能出现明文**；
 * 2. 旧版本留下的明文能平滑迁移（升级后不用重填密钥）；
 * 3. 没有加密服务时如实退回明文，**不假装加密**。
 *
 * 这里用假的加密服务（真实 DPAPI 在 Rust 侧，已由 cargo test 覆盖）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { LlmSettingsStore } from '../llm/settings.js';
import { CIPHER_PREFIX, isCipher, secretServiceFromEnv, type SecretCipher } from '../llm/secret.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** 假加密：加前缀并反转，够用来验证"磁盘上不是明文"。 */
function fakeCipher(): SecretCipher {
  return {
    available: true,
    async encrypt(plain) {
      return `enc(${plain.split('').reverse().join('')})`;
    },
    async decrypt(cipher) {
      // 格式不对就报错——真实的 DPAPI 也是这样（不是合法密文就解不开）。
      if (!/^enc\(.*\)$/.test(cipher)) {
        throw new Error('不是有效的密文');
      }
      const inner = cipher.slice(4, -1);
      return inner.split('').reverse().join('');
    },
  };
}

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-key-'));
  temps.push(dir);
  return path.join(dir, 'llm.json');
}

describe('密钥加密落盘', () => {
  it('**有加密服务时，磁盘上查不到明文**', async () => {
    const file = await tmpFile();
    const store = new LlmSettingsStore({ file, cipher: fakeCipher() });
    const secret = 'sk-super-secret-1234567890';

    await store.save({ apiKey: secret, baseUrl: 'https://x', model: 'm' });

    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes(secret), `磁盘上不该出现明文：${raw}`);
    assert.match(raw, /dpapi:/, '应以密文前缀存储');
  });

  it('读回来还是原值', async () => {
    const file = await tmpFile();
    const store = new LlmSettingsStore({ file, cipher: fakeCipher() });
    const secret = 'sk-roundtrip-abcdef';

    await store.save({ apiKey: secret, baseUrl: 'https://x', model: 'm' });
    assert.equal((await store.read())?.apiKey, secret);
  });

  it('storageMode 报告 encrypted', async () => {
    const store = new LlmSettingsStore({ file: await tmpFile(), cipher: fakeCipher() });
    assert.equal(store.storageMode, 'encrypted');
    assert.equal((await store.status()).storage, 'encrypted');
  });
});

describe('没有加密服务时', () => {
  it('如实退到明文存储，storageMode 报告 plaintext', async () => {
    const file = await tmpFile();
    const store = new LlmSettingsStore({ file, cipher: null });

    await store.save({ apiKey: 'sk-plain', baseUrl: 'https://x', model: 'm' });
    assert.equal((await readFile(file, 'utf8')).includes('sk-plain'), true);
    assert.equal(store.storageMode, 'plaintext');
    assert.equal((await store.status()).storage, 'plaintext');
  });
});

describe('旧明文平滑迁移', () => {
  it('**旧版本存下的明文升级后仍能用**', async () => {
    const file = await tmpFile();
    // 模拟旧版本直接写了明文
    await writeFile(
      file,
      JSON.stringify({ apiKey: 'sk-old-plain', baseUrl: 'https://x', model: 'm' }),
      'utf8',
    );

    // 升级后：有加密服务
    const store = new LlmSettingsStore({ file, cipher: fakeCipher() });
    assert.equal((await store.read())?.apiKey, 'sk-old-plain', '旧明文必须能读出来');

    // 重新保存后转成密文
    await store.save({ apiKey: 'sk-old-plain', baseUrl: 'https://x', model: 'm' });
    const raw = await readFile(file, 'utf8');
    assert.ok(!raw.includes('sk-old-plain'));
  });

  it('密文坏掉时当作未配置，不抛异常', async () => {
    const file = await tmpFile();
    await writeFile(file, JSON.stringify({ apiKey: `${CIPHER_PREFIX}garbage` }), 'utf8');
    const store = new LlmSettingsStore({ file, cipher: fakeCipher() });
    assert.equal(await store.read(), null);
  });
});

describe('密文标记', () => {
  it('识别密文前缀', () => {
    assert.equal(isCipher(`${CIPHER_PREFIX}abc`), true);
    assert.equal(isCipher('sk-plaintext'), false);
  });
});

describe('从环境变量接入加密服务', () => {
  it('缺少地址或令牌时不启用', () => {
    assert.equal(secretServiceFromEnv({}), null);
    assert.equal(secretServiceFromEnv({ OPENCOXSWAIN_SECRET_URL: 'http://x' }), null);
    assert.equal(secretServiceFromEnv({ OPENCOXSWAIN_SECRET_TOKEN: 't' }), null);
  });

  it('两者齐备时可用，并带上 Authorization', async () => {
    let seenAuth = '';
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seenAuth = String((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ cipher: 'abc' }), { status: 200 });
    }) as unknown as typeof fetch;

    const cipher = secretServiceFromEnv(
      { OPENCOXSWAIN_SECRET_URL: 'http://127.0.0.1:47901', OPENCOXSWAIN_SECRET_TOKEN: 'tok' },
      fakeFetch,
    );
    assert.ok(cipher);
    assert.equal(await cipher.encrypt('x'), 'abc');
    assert.equal(seenAuth, 'Bearer tok');
  });

  it('服务返回错误时抛出可读原因', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'DPAPI 不可用' }), { status: 500 })) as unknown as typeof fetch;

    const cipher = secretServiceFromEnv(
      { OPENCOXSWAIN_SECRET_URL: 'http://x', OPENCOXSWAIN_SECRET_TOKEN: 't' },
      fakeFetch,
    );
    await assert.rejects(() => cipher!.encrypt('x'), /DPAPI 不可用/);
  });
});
