/**
 * 多模型配置测试。
 *
 * 守三件事：
 * 1. 角色绑定的解析（三角色可绑不同模型）
 * 2. 参数校验给出人话错误，不静默丢弃
 * 3. 密钥落盘是密文（多个模型也不退回明文）
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  EMPTY_MODEL_SETTINGS,
  PARAM_LIMITS,
  modelForRole,
  toRequestOptions,
  validateParams,
  validateSettings,
  type ModelConfig,
  type ModelSettings,
} from '../llm/models.js';
import { ModelStore, isEncryptedKey } from '../llm/modelStore.js';
import type { SecretCipher } from '../llm/secret.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-model-'));
  temps.push(d);
  return d;
}

function model(over: Partial<ModelConfig> & { id: string }): ModelConfig {
  return {
    name: over.id,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    params: {},
    ...over,
  };
}

/** 假加密：前缀标记，可逆。 */
const fakeCipher: SecretCipher = {
  available: true,
  encrypt: async (plain: string) => `dpapi:${Buffer.from(plain).toString('base64')}`,
  decrypt: async (cipher: string) =>
    cipher.startsWith('dpapi:')
      ? Buffer.from(cipher.slice(6), 'base64').toString('utf8')
      : cipher,
};

describe('角色绑定', () => {
  const settings: ModelSettings = {
    models: [model({ id: 'strong' }), model({ id: 'cheap' })],
    roles: { supervisor: 'strong', assistant: 'strong', agent: 'cheap' },
  };

  it('**三角色可以绑不同模型**', () => {
    assert.equal(modelForRole(settings, 'supervisor')?.id, 'strong');
    assert.equal(modelForRole(settings, 'agent')?.id, 'cheap');
  });

  it('没绑定返回 null', () => {
    assert.equal(modelForRole(EMPTY_MODEL_SETTINGS, 'agent'), null);
  });

  it('绑定指向不存在的模型时返回 null 而不是崩', () => {
    const broken: ModelSettings = { models: [], roles: { supervisor: 'ghost', assistant: null, agent: null } };
    assert.equal(modelForRole(broken, 'supervisor'), null);
  });
});

describe('参数校验', () => {
  it('合法参数无错误', () => {
    assert.deepEqual(validateParams({ temperature: 0.7, topP: 0.9, maxToolRounds: 10 }), []);
  });

  it('**Temperature 超范围要有可读错误**', () => {
    const errors = validateParams({ temperature: 5 });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /Temperature/);
    assert.match(errors[0]!, /0–2/);
  });

  it('Top P 必须在 0-1', () => {
    assert.match(validateParams({ topP: 1.5 })[0]!, /Top P/);
  });

  it('上下文长度下限', () => {
    assert.match(validateParams({ contextLength: 100 })[0]!, /至少/);
  });

  it('工具轮数上限', () => {
    assert.match(validateParams({ maxToolRounds: 9999 })[0]!, /不能超过/);
  });

  it('非整数被拒', () => {
    assert.match(validateParams({ maxToolRounds: 3.5 })[0]!, /至少/);
  });

  it('范围常量与校验一致', () => {
    assert.equal(PARAM_LIMITS.temperature.max, 2);
    assert.deepEqual(validateParams({ temperature: PARAM_LIMITS.temperature.max }), []);
  });
});

describe('整体配置校验', () => {
  it('**id 重复被拒**', () => {
    const errors = validateSettings({
      models: [model({ id: 'a' }), model({ id: 'a' })],
      roles: { supervisor: null, assistant: null, agent: null },
    });
    assert.ok(errors.some((e) => /重复/.test(e)));
  });

  it('缺端点被拒', () => {
    const errors = validateSettings({
      models: [model({ id: 'a', baseUrl: '' })],
      roles: { supervisor: null, assistant: null, agent: null },
    });
    assert.ok(errors.some((e) => /端点/.test(e)));
  });

  it('绑定指向不存在的模型被拒', () => {
    const errors = validateSettings({
      models: [model({ id: 'a' })],
      roles: { supervisor: 'ghost', assistant: null, agent: null },
    });
    assert.ok(errors.some((e) => /不存在的模型/.test(e)));
  });
});

describe('请求参数转换', () => {
  it('只带有值的字段', () => {
    const out = toRequestOptions({ temperature: 0.5 });
    assert.deepEqual(out, { temperature: 0.5 });
  });

  it('空参数不产生任何字段', () => {
    assert.deepEqual(toRequestOptions({}), {});
  });

  it('思考强度映射成 reasoning_effort', () => {
    assert.deepEqual(toRequestOptions({ reasoningEffort: 'high' }), { reasoning_effort: 'high' });
  });
});

describe('持久化', () => {
  it('**密钥落盘是密文**', async () => {
    const file = path.join(await tmp(), 'models.json');
    const store = new ModelStore({ file, cipher: fakeCipher });
    await store.save({
      models: [model({ id: 'a', apiKey: 'sk-secret' })],
      roles: { supervisor: 'a', assistant: 'a', agent: 'a' },
    });

    const onDisk = await readFile(file, 'utf8');
    assert.ok(!onDisk.includes('sk-secret'), '磁盘上不该出现明文密钥');
    assert.ok(onDisk.includes('dpapi:'), '应当是密文');
  });

  it('读回来时解密', async () => {
    const file = path.join(await tmp(), 'models.json');
    const store = new ModelStore({ file, cipher: fakeCipher });
    await store.save({
      models: [model({ id: 'a', apiKey: 'sk-secret' })],
      roles: { supervisor: 'a', assistant: null, agent: null },
    });

    const loaded = await store.load();
    assert.equal(loaded.models[0]?.apiKey, 'sk-secret');
  });

  it('没有加密服务时如实报明文', () => {
    const store = new ModelStore({ file: 'x.json', cipher: null });
    assert.equal(store.storageMode(), 'plaintext');
  });

  it('有加密服务时报加密', () => {
    const store = new ModelStore({ file: 'x.json', cipher: fakeCipher });
    assert.equal(store.storageMode(), 'encrypted');
  });

  it('文件不存在时返回空配置', async () => {
    const store = new ModelStore({ file: path.join(await tmp(), 'nope.json') });
    const loaded = await store.load();
    assert.equal(loaded.models.length, 0);
    assert.equal(loaded.roles.agent, null);
  });

  it('已是密文的密钥不重复加密', async () => {
    const file = path.join(await tmp(), 'models.json');
    const store = new ModelStore({ file, cipher: fakeCipher });
    const cipher = await fakeCipher.encrypt('sk-x');
    await store.save({ models: [model({ id: 'a', apiKey: cipher })], roles: { supervisor: null, assistant: null, agent: null } });

    const onDisk = await readFile(file, 'utf8');
    // 只应有一层 dpapi: 前缀
    assert.equal((onDisk.match(/dpapi:/g) ?? []).length, 1);
  });

  it('isEncryptedKey 判断前缀', () => {
    assert.equal(isEncryptedKey('dpapi:abc'), true);
    assert.equal(isEncryptedKey('sk-abc'), false);
  });
});
