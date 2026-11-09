import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type {
  MemoryEntry,
  MemoryMatch,
  MemoryReport,
  MemoryWriteResult,
  Task,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import { makeDaemon, makeRepo } from './helpers.js';

test('记忆层：写入门槛、检索、规划引用与检查器', async () => {
  const fixture = await makeRepo({
    'package.json': JSON.stringify({
      name: 'demo',
      packageManager: 'pnpm@9.0.0',
      devDependencies: { typescript: '^5.6.0', react: '^18.3.0' },
    }),
  });
  const { app, call } = await makeDaemon(fixture.home);
  try {
    const project = await call<{ id: string; name: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo, name: '记忆演示' }),
    });

    const initial = await call<{ entries: MemoryEntry[] }>(
      `/api/memory?projectId=${project.id}`,
    );
    const stack = initial.entries.find((entry) => entry.kind === 'project');
    assert.ok(stack, '创建项目时自动记录技术栈');
    assert.match(stack!.text, /Node\.js/);
    assert.match(stack!.text, /pnpm/);

    await assert.rejects(
      call<MemoryWriteResult>('/api/memory', {
        method: 'POST',
        body: JSON.stringify({
          kind: 'profile',
          text: '这次先不用写测试',
          projectId: project.id,
        }),
      }),
      /临时指令/,
    );

    const written = await call<MemoryWriteResult>('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'profile',
        text: '提交信息使用中文，偏好 pnpm 工作区',
        projectId: project.id,
      }),
    });
    assert.equal(written.action, 'created');

    const searched = await call<{ matches: MemoryMatch[] }>(
      `/api/memory?projectId=${project.id}&q=${encodeURIComponent('提交信息')}`,
    );
    assert.ok(searched.matches.length >= 1, '关键词检索命中写入的记忆');

    const planned = await call<{ root: Task }>(`/api/projects/${project.id}/plan`, {
      method: 'POST',
      body: JSON.stringify({ goal: '提交信息使用中文，并检查 pnpm 工作区配置' }),
    });
    assert.ok(planned.root.id);

    const snapshot = await call<WorkbenchSnapshot>('/api/bootstrap');
    const message = snapshot.messages.filter((item) => item.role === 'assistant').at(-1);
    assert.ok(message, '产出规划消息');
    assert.match(message!.content, /我参考了这些记忆/);
    assert.match(message!.content, /提交信息使用中文/);
    assert.ok(
      snapshot.events.some((event) => event.type === 'memory.used' && event.taskId === planned.root.id),
      '落 memory.used 审计事件',
    );
    assert.ok(snapshot.memory.total >= 2, '快照携带记忆统计');

    const report = await call<MemoryReport>(`/api/memory/check?projectId=${project.id}`);
    assert.equal(report.stats.total, snapshot.memory.total);
    assert.ok(Array.isArray(report.issues));
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
