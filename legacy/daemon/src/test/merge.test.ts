import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Approval, Task, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

async function pendingApproval(
  call: <T>(url: string, init?: RequestInit) => Promise<T>,
): Promise<Approval> {
  return waitFor(async () => {
    const snapshot = await call<WorkbenchSnapshot>('/api/bootstrap');
    return snapshot.approvals.find((approval) => approval.status === 'pending') ?? null;
  });
}

test('合并冲突：多依赖同文件冲突时转人审而非失败', async () => {
  const fixture = await makeRepo({ 'a.txt': 'base\n' });
  const { app, call } = await makeDaemon(fixture.home);
  try {
    const project = await call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '验证合并冲突转人审',
          subtasks: [
            {
              title: '实施一：写入 a',
              goal: '将 a.txt 写为 a',
              role: 'implementer',
              writeScope: ['a.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
              inputs: { mock: { files: [{ path: 'a.txt', content: 'a\n' }] } },
            },
            {
              title: '实施二：写入 b',
              goal: '将 a.txt 写为 b',
              role: 'implementer',
              writeScope: ['a.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
              inputs: { mock: { files: [{ path: 'a.txt', content: 'b\n' }] } },
            },
            {
              title: '校验：合并两条依赖',
              goal: '同时依赖两次实施',
              role: 'verifier',
              dependsOn: [0, 1],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
            },
          ],
        }),
      },
    );
    const mergeTaskId = planned.children[2]!.id;
    await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    const approval = await pendingApproval(call);
    assert.equal(approval.type, 'merge_conflict');
    assert.equal(approval.taskId, mergeTaskId);

    const snapshot = await waitFor(async () => {
      const current = await call<WorkbenchSnapshot>('/api/bootstrap');
      const task = current.tasks.find((item) => item.id === mergeTaskId);
      return task?.status === 'blocked' ? current : null;
    });
    assert.ok(
      snapshot.events.some((event) => event.type === 'merge.conflict'),
      '产出合并冲突事件',
    );
    assert.match(
      snapshot.messages.filter((item) => item.role === 'assistant').at(-1)!.content,
      /合并依赖分支时发生冲突/,
    );
    const refs = (approval.payload as { refs?: string[] }).refs ?? [];
    assert.equal(refs.length, 2, '审批载荷包含两条依赖分支');
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
