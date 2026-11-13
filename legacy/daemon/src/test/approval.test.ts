import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type {
  Approval,
  ProjectCostReport,
  Task,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

async function setup(action: { tool: string; input: unknown }) {
  const fixture = await makeRepo({ 'a.txt': 'x\n' });
  const { app, call, text } = await makeDaemon(fixture.home);
  const project = await call<{ id: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ path: fixture.repo }),
  });
  const planned = await call<{ root: Task; children: Task[] }>(
    `/api/projects/${project.id}/plan`,
    {
      method: 'POST',
      body: JSON.stringify({
        goal: '验证危险动作人审',
        subtasks: [
          {
            title: '实施：危险动作',
            goal: '执行危险动作并写入 a.txt',
            role: 'implementer',
            writeScope: ['a.txt'],
            acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
            inputs: {
              mock: {
                actions: [action],
                files: [{ path: 'a.txt', content: 'y\n' }],
              },
            },
          },
          {
            title: '校验：危险动作之后',
            goal: '实施完成后校验',
            role: 'verifier',
            dependsOn: [0],
            acceptance: [{ id: 'ac_human', type: 'human', desc: '用户验收' }],
          },
        ],
      }),
    },
  );
  await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
  return {
    fixture,
    app,
    call,
    text,
    projectId: project.id,
    rootId: planned.root.id,
    childId: planned.children[0]!.id,
  };
}

async function pendingApproval(
  call: <T>(url: string, init?: RequestInit) => Promise<T>,
): Promise<Approval> {
  return waitFor(async () => {
    const snapshot = await call<WorkbenchSnapshot>('/api/bootstrap');
    return snapshot.approvals.find((approval) => approval.status === 'pending') ?? null;
  });
}

test('危险动作人审：批准后继续执行', async () => {
  const context = await setup({ tool: 'bash', input: { command: 'git push origin main' } });
  try {
    const approval = await pendingApproval(context.call);
    assert.equal(approval.type, 'action:push');
    assert.equal(approval.taskId, context.childId);

    const waiting = await context.call<WorkbenchSnapshot>('/api/bootstrap');
    assert.ok(
      waiting.events.some((event) => event.type === 'approval.requested'),
      '产出审批请求事件',
    );
    assert.match(
      waiting.messages.filter((item) => item.role === 'assistant').at(-1)!.content,
      /## 待你决策/,
    );
    assert.equal(
      waiting.tasks.find((task) => task.id === context.childId)?.status,
      'running',
      '审批期间会话冻结在运行态',
    );

    await context.call(`/api/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ status: 'approved' }),
    });

    const done = await waitFor(async () => {
      const snapshot = await context.call<WorkbenchSnapshot>('/api/bootstrap');
      const root = snapshot.tasks.find((task) => task.id === context.rootId);
      return root?.status === 'awaiting_review' ? snapshot : null;
    });
    const child = done.tasks.find((task) => task.id === context.childId);
    assert.equal(child?.status, 'awaiting_review', '批准后实施任务执行完成');
    assert.equal(
      done.approvals.find((item) => item.id === approval.id)?.status,
      'approved',
    );

    const costs = await context.call<ProjectCostReport>(
      `/api/projects/${context.projectId}/costs`,
    );
    assert.ok(costs.totalUsd > 0, '项目成本报表汇总运行成本');
    assert.ok(costs.byModel.length > 0, '成本报表按模型分组');
    assert.ok(
      costs.byTask.some((row) => row.taskId === context.childId),
      '成本报表包含实施任务',
    );
    assert.ok(costs.daily.length > 0, '成本报表按日分组');

    const replay = await context.text(
      `/api/tasks/${context.rootId}/replay?format=markdown`,
    );
    assert.match(replay, /^# 验证危险动作人审/m);
    assert.match(replay, /## 事件时间线/);
    assert.match(replay, /## 子任务/);
  } finally {
    await context.app.close();
    await rm(context.fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('危险动作人审：拒绝后停止执行', async () => {
  const context = await setup({ tool: 'bash', input: { command: 'rm -rf build' } });
  try {
    const approval = await pendingApproval(context.call);
    assert.equal(approval.type, 'action:delete');

    await context.call(`/api/approvals/${approval.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ status: 'rejected' }),
    });

    const failed = await waitFor(async () => {
      const snapshot = await context.call<WorkbenchSnapshot>('/api/bootstrap');
      return snapshot.tasks.find((task) => task.id === context.childId)?.status === 'failed'
        ? snapshot
        : null;
    });
    assert.equal(
      failed.approvals.find((item) => item.id === approval.id)?.status,
      'rejected',
    );
    assert.ok(
      failed.events.some(
        (event) =>
          event.type === 'runtime.error' &&
          typeof (event.payload as { message?: string }).message === 'string' &&
          (event.payload as { message: string }).message.includes('危险动作被拒绝'),
      ),
      '拒绝后运行时终止',
    );
  } finally {
    await context.app.close();
    await rm(context.fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
