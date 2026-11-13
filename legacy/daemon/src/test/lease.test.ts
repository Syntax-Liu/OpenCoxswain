import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task, TaskContract, Worker } from '@opencoxswain/shared';
import { Store } from '../store.js';

function childTask(projectId: string): Task {
  const contract: TaskContract = {
    task_id: 'tsk_child',
    parent_id: 'tsk_root',
    project_id: projectId,
    title: '子任务',
    goal: '写一份报告',
    deliverables: [{ type: 'file' }],
    acceptance_criteria: [{ id: 'ac1', type: 'diff', desc: '改动一致' }],
    dependencies: [],
    write_scope: ['docs/'],
    assignee: { role: 'writer', runtime: 'mock', model: 'mock' },
    budget: { usd: 1 },
    review: { required: false },
  };
  return {
    id: contract.task_id,
    projectId,
    parentId: 'tsk_root',
    title: contract.title,
    goal: contract.goal,
    status: 'queued',
    assigneeId: null,
    contract,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function worker(id: string, taskId: string): Worker {
  return {
    id,
    taskId,
    role: 'writer',
    runtime: 'mock',
    model: 'mock',
    worktreePath: '/tmp/wt',
    branch: `oc/${taskId}`,
    sessionRef: null,
    status: 'starting',
    cost: { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('G5 租约：并发认领互斥、过期回收、复用 run 记录', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-lease-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = store.createProject({
    name: 'p',
    path: dir,
    defaultBranch: 'main',
    dailyBudgetUsd: 10,
    maxConcurrency: 2,
  });
  const root = childTask(project.id);
  const rootTask: Task = {
    ...root,
    id: 'tsk_root',
    parentId: null,
    contract: {
      ...root.contract,
      task_id: 'tsk_root',
      parent_id: null,
      acceptance_criteria: [],
    },
  };
  store.insertTask(rootTask);
  const task = childTask(project.id);
  store.insertTask(task);
  const first = worker('wrk_1', task.id);
  store.insertWorker(first);
  store.insertRun('run_1', first.id, 1);

  assert.equal(store.claimRun('run_1', 'A', 30_000), true);
  assert.equal(store.claimRun('run_1', 'B', 30_000), false, '同一租约不能被第二个实例抢到');
  assert.equal(store.renewLease('run_1', 'B', 30_000), false);
  assert.equal(store.renewLease('run_1', 'A', 30_000), true);

  store.releaseRun('run_1');
  assert.equal(store.claimRun('run_1', 'A', -1), true, '负 TTL 立即过期');
  assert.deepEqual(
    store.listExpiredRuns(Date.now()).map((run) => run.runId),
    ['run_1'],
  );

  store.markRunOrphaned('run_1');
  assert.equal(store.getActiveRun(task.id)?.status, 'orphaned');
  assert.equal(store.takeOrphanRun(task.id), 'run_1');

  const second = worker('wrk_2', task.id);
  store.insertWorker(second);
  store.reviveRun('run_1', second.id, 'A', 30_000);
  const revived = store.getActiveRun(task.id);
  assert.equal(revived?.id, 'run_1', '重派复用原 run，避免重复计费');
  assert.equal(revived?.attempt, 2);
  assert.equal(revived?.leaseOwner, 'A');
  assert.equal(store.listExpiredRuns(Date.now()).length, 0);
  assert.equal(store.takeOrphanRun(task.id), null);

  store.markRunRecoveredUnknown('run_1');
  assert.equal(store.getActiveRun(task.id)?.recoveredUnknown, true, '租约未过期的重启现场会标记结果未知');

  store.finishRun('run_1', null, 'boom');
  assert.equal(store.getActiveRun(task.id), null);
});
