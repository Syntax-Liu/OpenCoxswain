/**
 * 权限档位测试。
 *
 * 这组测试守的是**安全边界**：
 * 最严的"仅可查看"必须真的不写文件，最松的"完全权限"也必须留台账。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_PERMISSION,
  LEVEL_HINT,
  LEVEL_LABEL,
  PERMISSION_LEVELS,
  PermissionStore,
  accessFor,
  allowsWrite,
  isPermissive,
  needsApproval,
  parseLevel,
} from '../settings/permission.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient } from './mock-llm.js';
import { MemoryPermissionStore } from '../settings/permission.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-perm-'));
  temps.push(d);
  return d;
}

describe('四档定义', () => {
  it('正好四档，顺序从严到松', () => {
    assert.deepEqual([...PERMISSION_LEVELS], ['readonly', 'manual', 'auto', 'full']);
  });

  it('每档都有中文名和说明', () => {
    for (const level of PERMISSION_LEVELS) {
      assert.ok(LEVEL_LABEL[level], `${level} 缺标签`);
      assert.ok(LEVEL_HINT[level], `${level} 缺说明`);
    }
    assert.equal(LEVEL_LABEL.readonly, '仅可查看');
    assert.equal(LEVEL_LABEL.manual, '手动审批');
  });
});

describe('写权限', () => {
  it('**仅可查看档不写文件**', () => {
    assert.equal(allowsWrite('readonly'), false);
    assert.equal(accessFor('readonly'), 'readonly');
  });

  it('其余三档都允许写', () => {
    for (const level of ['manual', 'auto', 'full'] as const) {
      assert.equal(allowsWrite(level), true, level);
      assert.equal(accessFor(level), 'readwrite', level);
    }
  });
});

describe('危险动作要不要问', () => {
  it('**仅可查看与手动审批都要问**', () => {
    assert.equal(needsApproval('readonly', 'delete'), true);
    assert.equal(needsApproval('manual', 'delete'), true);
    assert.equal(needsApproval('manual', 'push'), true);
  });

  it('**自动审批与完全权限不问**', () => {
    assert.equal(needsApproval('auto', 'delete'), false);
    assert.equal(needsApproval('full', 'pay'), false);
  });

  it('permissive 判定', () => {
    assert.equal(isPermissive('readonly'), false);
    assert.equal(isPermissive('manual'), false);
    assert.equal(isPermissive('auto'), true);
    assert.equal(isPermissive('full'), true);
  });
});

describe('非法输入', () => {
  it('不认识的值退回手动审批', () => {
    assert.equal(parseLevel('乱写'), 'manual');
    assert.equal(parseLevel(undefined), 'manual');
    assert.equal(parseLevel(123), 'manual');
  });

  it('合法值原样保留', () => {
    assert.equal(parseLevel('full'), 'full');
  });
});

describe('持久化', () => {
  it('存进去再读出来', async () => {
    const file = path.join(await tmp(), 'perm.json');
    const store = new PermissionStore(file);
    await store.save({ level: 'auto', projects: {} });
    assert.equal((await store.load()).level, 'auto');
  });

  it('文件不存在时用手动审批', async () => {
    const store = new PermissionStore(path.join(await tmp(), 'nope.json'));
    assert.equal((await store.load()).level, DEFAULT_PERMISSION.level);
  });
});

describe('端到端：档位影响派活', () => {
  it('**仅可查看档下派活自动变成只读 Agent**', async () => {
    const store = new MemoryStore();
    const permissions = new MemoryPermissionStore();
    await permissions.save({ level: 'readonly', projects: {} });
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
      permissions,
    });
    const { project } = await runtime.openProject({ rootPath: await tmp() });

    const result = await runtime.spawn(project.id, {
      label: '想写文件的活',
      goal: '改点东西',
      writeScope: ['src'],
    });

    const agent = result.executor;
    assert.equal(agent?.access, 'readonly', '仅可查看档不该派出可写的 Agent');

    await runtime.dispose();
  });

  it('手动审批档下保持原样', async () => {
    const store = new MemoryStore();
    const permissions = new MemoryPermissionStore();
    await permissions.save({ level: 'manual', projects: {} });
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
      permissions,
    });
    const { project } = await runtime.openProject({ rootPath: await tmp() });

    const result = await runtime.spawn(project.id, {
      label: '正常派活',
      goal: '改点东西',
      writeScope: ['src'],
    });
    const agent = result.executor;
    assert.equal(agent?.access, 'readwrite');

    await runtime.dispose();
  });

  it('改档位立即生效', async () => {
    const store = new MemoryStore();
    const permissions = new MemoryPermissionStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
      permissions,
    });

    assert.equal((await runtime.permissionSettings()).level, 'manual');
    await runtime.setPermissionLevel('full');
    assert.equal((await runtime.permissionSettings()).level, 'full');

    await runtime.dispose();
  });
});
