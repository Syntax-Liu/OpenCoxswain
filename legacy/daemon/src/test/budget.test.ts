import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Task, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

test('预算硬停：运行中超出任务预算立即停止并请求决策', async () => {
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
          goal: '验证预算硬停',
          subtasks: [
            {
              title: '实施：超预算',
              goal: '写入 a.txt',
              role: 'implementer',
              writeScope: ['a.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
              inputs: {
                mock: {
                  files: [{ path: 'a.txt', content: 'y\n' }],
                  cost: { usd: 0.02, tokens: 1000, minutes: 1 },
                },
              },
              budget: { usd: 0.01 },
            },
            {
              title: '校验：等待实施完成',
              goal: '实施完成后校验',
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
      return current.tasks.find((task) => task.id === childId)?.status === 'blocked'
        ? current
        : null;
    });

    assert.equal(snapshot.tasks.find((task) => task.id === childId)?.status, 'blocked');
    assert.equal(
      snapshot.workers.find((worker) => worker.taskId === childId)?.status,
      'terminated',
    );
    assert.ok(
      snapshot.events.some(
        (event) =>
          event.type === 'budget.exceeded' &&
          (event.payload as { scope?: string }).scope === 'task',
      ),
      '产出任务级预算硬停事件',
    );
    const message = snapshot.messages.filter((item) => item.role === 'assistant').at(-1);
    assert.ok(message, '产出请示消息');
    assert.match(message!.content, /## 待你决策/);
    assert.match(message!.content, /预算硬停/);
  } finally {
    await app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
