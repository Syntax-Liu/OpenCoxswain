import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Task, TaskMandate, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

test('失败重试：可重试错误自动重试一次后升级人审', async () => {
  const fixture = await makeRepo({ 'a.txt': 'x\n' });
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
          goal: '验证失败重试',
          subtasks: [
            {
              title: '实施：必然失败',
              goal: '运行时返回可重试错误',
              role: 'implementer',
              writeScope: ['a.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
              inputs: { mock: { fail: true } },
            },
            {
              title: '校验：等待实施失败',
              goal: '实施失败后校验',
              role: 'verifier',
              dependsOn: [0],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
            },
          ],
        }),
      },
    );
    const childId = planned.children[0]!.id;
    await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    const snapshot = await waitFor(async () => {
      const current = await call<WorkbenchSnapshot>('/api/bootstrap');
      const child = current.tasks.find((task) => task.id === childId);
      const escalated = current.events.some(
        (event) => event.type === 'task.escalated' && event.taskId === childId,
      );
      return child?.status === 'failed' && escalated ? current : null;
    });

    const errors = snapshot.events.filter(
      (event) =>
        event.type === 'runtime.error' &&
        (event.payload as { retryable?: boolean }).retryable === true,
    );
    assert.equal(errors.length, 2, '首次失败后自动重试一次，共两次可重试错误');

    const retrying = snapshot.events.find((event) => event.type === 'worker.retrying');
    assert.ok(retrying, '产出重试事件');
    assert.equal((retrying!.payload as { attempt: number }).attempt, 2);

    const escalated = snapshot.events.find(
      (event) => event.type === 'task.escalated' && event.taskId === childId,
    );
    assert.equal(
      (escalated!.payload as { reason?: string }).reason,
      'retry_exhausted',
      '重试耗尽后升级人审',
    );

    const message = snapshot.messages.filter((item) => item.role === 'assistant').at(-1);
    assert.ok(message, '产出请示消息');
    assert.match(message!.content, /## 待你决策/);
    assert.match(message!.content, /自动重试 2 次/);

    const retried = await call<Task>(`/api/tasks/${childId}/retry`, { method: 'POST' });
    assert.equal(retried.status, 'queued', '用户手动重试后任务重新排队');
    const after = await call<WorkbenchSnapshot>('/api/bootstrap');
    assert.ok(
      after.messages.some((item) => item.content.includes('已重新排队执行')),
      '重试后给出提示消息',
    );
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('任务树重派：跨编制改派必须重签授权', async () => {
  const fixture = await makeRepo({ 'a.txt': 'x\n' });
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
          goal: '验证重派',
          subtasks: [
            {
              title: '实施：必然失败',
              goal: '运行时返回可重试错误',
              role: 'implementer',
              writeScope: ['a.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
              inputs: { mock: { fail: true } },
            },
            {
              title: '校验：等待实施失败',
              goal: '实施失败后校验',
              role: 'verifier',
              dependsOn: [0],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
            },
          ],
        }),
      },
    );
    const childId = planned.children[0]!.id;
    await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    await waitFor(async () => {
      const current = await call<WorkbenchSnapshot>('/api/bootstrap');
      return current.tasks.find((task) => task.id === childId)?.status === 'failed'
        ? current
        : null;
    });

    const reassigned = await call<Task>(`/api/tasks/${childId}/reassign`, {
      method: 'POST',
      body: JSON.stringify({ role: 'writer', note: '换成撰写员' }),
    });
    assert.equal(reassigned.contract.assignee?.role, 'writer');
    assert.equal(reassigned.contract.delegated_by, 'user');
    assert.equal(reassigned.status, 'queued', '重派后重新排队');

    const mandates = await call<{ latest: TaskMandate | null; mandates: TaskMandate[] }>(
      `/api/tasks/${childId}/mandate`,
    );
    assert.equal(mandates.mandates.length, 2, '跨编制改派签发新授权');
    assert.deepEqual(mandates.latest?.roles, ['writer']);

    const snapshot = await call<WorkbenchSnapshot>('/api/bootstrap');
    const event = snapshot.events.find(
      (item) => item.type === 'task.reassigned' && item.taskId === childId,
    );
    assert.ok(event, '记录重派事件');
    assert.equal((event!.payload as { fromRole: string }).fromRole, 'implementer');
    assert.equal((event!.payload as { toRole: string }).toRole, 'writer');
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
