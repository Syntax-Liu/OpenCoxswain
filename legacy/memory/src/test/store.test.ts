import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../index.js';

function fixture(now = 1_800_000_000_000) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocsw-memory-'));
  const store = new MemoryStore({
    dbPath: path.join(dir, 'memory.db'),
    memoryDir: path.join(dir, 'memory'),
    now: () => now,
  });
  return { dir, store, memoryDir: path.join(dir, 'memory') };
}

test('记忆写入、去重与检索', () => {
  const { dir, store } = fixture();
  try {
    const created = store.remember({
      kind: 'profile',
      text: '偏好 pnpm 工作区与 TypeScript strict',
      source: 'user:manual',
    });
    assert.equal(created.action, 'created');

    const deduped = store.remember({
      kind: 'profile',
      text: '偏好   pnpm 工作区与 TypeScript strict ',
      source: 'user:manual',
    });
    assert.equal(deduped.action, 'deduped');

    const matches = store.recall('pnpm 工作区', { limit: 5 });
    assert.equal(matches.length, 1);
    assert.match(matches[0]!.entry.text, /pnpm/);
    assert.ok((matches[0]!.entry.useCount ?? 0) >= 1, '召回后记录使用次数');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同键新记忆取代旧记忆，旧记录不参与检索', () => {
  const { dir, store } = fixture();
  try {
    const first = store.remember({
      kind: 'project',
      key: 'stack.runtime',
      text: '项目运行时使用 Node 20',
      source: 'scan',
      projectId: 'prj_1',
    });
    assert.equal(first.action, 'created');

    const second = store.remember({
      kind: 'project',
      key: 'stack.runtime',
      text: '项目运行时使用 Node 24',
      source: 'scan',
      projectId: 'prj_1',
    });
    assert.equal(second.action, 'superseded');

    const matches = store.recall('Node 运行时', { projectId: 'prj_1', limit: 5 });
    assert.equal(matches.length, 1);
    assert.match(matches[0]!.entry.text, /Node 24/);

    const report = store.report('prj_1');
    assert.equal(report.stats.total, 1);
    assert.equal(report.stats.byKind.project, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('拒绝临时指令与疑似密钥，并导出 Markdown 快照', () => {
  const { dir, store, memoryDir } = fixture();
  try {
    const transient = store.remember({
      kind: 'profile',
      text: '这次先不用写测试',
      source: 'user',
    });
    assert.equal(transient.action, 'rejected');

    const secret = store.remember({
      kind: 'profile',
      text: 'api key: sk-abcdefghijklmnop',
      source: 'user',
    });
    assert.equal(secret.action, 'rejected');

    store.remember({
      kind: 'decision',
      text: '技术选型采用 pnpm workspace',
      source: 'task:tsk_1',
    });
    const snapshot = readFileSync(path.join(memoryDir, 'decisions.md'), 'utf8');
    assert.match(snapshot, /pnpm workspace/);
    assert.match(snapshot, /自动生成/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('记忆检查器报告重复与陈旧条目', () => {
  const { dir, store } = fixture();
  try {
    store.remember({ kind: 'profile', text: '偏好 pnpm 工作区', source: 'user:a' });
    store.remember({ kind: 'decision', text: '偏好 pnpm 工作区', source: 'user:b' });
    const report = store.report(null);
    assert.ok(report.issues.some((issue) => issue.code === 'duplicate'));
    assert.ok(report.stats.total >= 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
