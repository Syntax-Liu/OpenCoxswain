import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Task, TaskInput, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

test('G3 运行中输入：立即送达运行中的员工，其余排队等下次派发', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '改说明并补文档',
          subtasks: [
            {
              title: '实施：改说明',
              goal: '把说明改成 after',
              role: 'implementer',
              writeScope: ['note.txt'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认说明' }],
              inputs: {
                mock: {
                  files: [{ path: 'note.txt', content: 'after\n' }],
                  sleepMs: 1200,
                },
              },
            },
            {
              title: '撰写：补文档',
              goal: '写一份使用说明',
              role: 'writer',
              writeScope: ['docs/'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认文档' }],
              inputs: { mock: { files: [{ path: 'docs/NOTE.md', content: '# note\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    const implementer = planned.children[0]!;
    const writer = planned.children[1]!;
    await waitFor(async () => {
      const snapshot = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
      return snapshot.workers.some(
        (worker) => worker.taskId === implementer.id && worker.status === 'running',
      )
        ? true
        : null;
    });

    const delivered = await daemon.call<{
      input: TaskInput;
      delivery: string;
    }>(`/api/tasks/${implementer.id}/inputs`, {
      method: 'POST',
      body: JSON.stringify({ text: '优先改标题' }),
    });
    assert.equal(delivered.delivery, 'delivered');
    assert.equal(delivered.input.state, 'delivered');

    const queued = await daemon.call<{ input: TaskInput; delivery: string }>(
      `/api/tasks/${writer.id}/inputs`,
      { method: 'POST', body: JSON.stringify({ text: '文档里补一句示例' }) },
    );
    assert.equal(queued.delivery, 'queued');
    assert.equal(queued.input.state, 'pending');

    await waitFor(async () => {
      const snapshot = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
      const root = snapshot.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'awaiting_review' ? snapshot : null;
    });

    const implementerInputs = await daemon.call<{ inputs: TaskInput[] }>(
      `/api/tasks/${implementer.id}/inputs`,
    );
    assert.equal(implementerInputs.inputs[0]?.state, 'delivered');

    const writerInputs = await daemon.call<{ inputs: TaskInput[] }>(
      `/api/tasks/${writer.id}/inputs`,
    );
    assert.equal(writerInputs.inputs[0]?.state, 'consumed', '排队输入应在下次派发时注入');

    const snapshot = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
    assert.ok(
      snapshot.events.some(
        (event) => event.type === 'input.delivered' && event.taskId === implementer.id,
      ),
      '运行中投递应留下 input.delivered 事件',
    );

    await daemon.call(`/api/tasks/${planned.root.id}/cancel`, { method: 'POST' });
    await assert.rejects(
      daemon.call(`/api/tasks/${planned.root.id}/inputs`, {
        method: 'POST',
        body: JSON.stringify({ text: '已经结束了' }),
      }),
      /409/,
    );
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
