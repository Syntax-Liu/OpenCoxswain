import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Task, WorkbenchSnapshot } from '@opencoxswain/shared';
import { startDaemon } from '../app.js';
import { runGit } from '../git.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('v0 闭环：规划 -> 审批 -> 实施/校验 -> 汇总 -> 验收', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-e2e-'));
  const repo = path.join(temp, 'demo-repo');
  const home = path.join(temp, 'home');
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(repo, 'theme.txt'), 'light\n', 'utf8');
  await writeFile(
    path.join(repo, 'check.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const value = readFileSync(new URL('./theme.txt', import.meta.url), 'utf8').trim();",
      "if (value !== 'dark') { console.error('theme is ' + value); process.exit(1); }",
      "console.log('theme ok');",
    ].join('\n'),
    'utf8',
  );
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'OpenCoxswain Test']);
  await runGit(repo, ['config', 'user.email', 'test@opencoxswain.local']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'init']);

  const app = await startDaemon({
    homeDir: home,
    dbPath: path.join(home, 'test.db'),
    worktreesDir: path.join(home, 'worktrees'),
    artifactsDir: path.join(home, 'artifacts'),
    port: 0,
    // 闭环用 mock 运行时复现：真实执行体的接入由 adapter 与 planner 的测试覆盖。
    defaultRuntime: 'mock',
  });
  const base = `http://127.0.0.1:${app.port}`;

  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${url}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };

  try {
    const health = await call<{ ok: boolean }>('/api/health');
    assert.equal(health.ok, true);

    const project = await call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: repo }),
    });

    const planned = await call<{ root: Task; children: Task[] }>(`/api/projects/${project.id}/plan`, {
      method: 'POST',
      body: JSON.stringify({
        goal: '修复夜间模式，切换后立即生效',
        budget: { usd: 2, tokens: 200000, minutes: 30 },
        subtasks: [
          {
            title: '实施：夜间模式',
            goal: '让 theme.txt 在夜间模式切换后变为 dark',
            role: 'implementer',
            writeScope: ['theme.txt'],
            acceptance: [
              { id: 'ac_cmd', type: 'command', desc: '检查脚本通过', check: 'node check.mjs' },
              { id: 'ac_diff', type: 'diff', desc: '只修改 theme.txt' },
            ],
            inputs: { mock: { files: [{ path: 'theme.txt', content: 'dark\n' }] } },
            budget: { usd: 1, tokens: 100000, minutes: 15 },
          },
          {
            title: '校验：夜间模式',
            goal: '独立复跑验收并检查 diff',
            role: 'verifier',
            dependsOn: [0],
            acceptance: [
              { id: 'ac_cmd', type: 'command', desc: '独立复跑检查脚本', check: 'node check.mjs' },
              { id: 'ac_rubric', type: 'rubric', desc: 'diff 符合目标' },
            ],
            budget: { usd: 1, tokens: 100000, minutes: 15 },
          },
        ],
      }),
    });
    assert.equal(planned.root.status, 'awaiting_approval');

    await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    let snapshot: WorkbenchSnapshot | null = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      snapshot = await call<WorkbenchSnapshot>('/api/bootstrap');
      const root = snapshot.tasks.find((task) => task.id === planned.root.id);
      if (root?.status === 'awaiting_review' || root?.status === 'failed') break;
      await delay(250);
    }
    assert.ok(snapshot, '拿到工作台快照');
    const root = snapshot.tasks.find((task) => task.id === planned.root.id);
    if (root?.status !== 'awaiting_review') {
      console.error(
        JSON.stringify(
          {
            tasks: snapshot.tasks.map((task) => ({
              title: task.title,
              role: task.contract.assignee?.role,
              status: task.status,
            })),
            workers: snapshot.workers.map((worker) => ({
              role: worker.role,
              status: worker.status,
              worktree: worker.worktreePath,
            })),
            events: snapshot.events.slice(-30).map((event) => ({
              type: event.type,
              payload: event.payload,
            })),
          },
          null,
          2,
        ),
      );
    }
    assert.equal(root?.status, 'awaiting_review');

    const children = snapshot.tasks.filter((task) => task.parentId === planned.root.id);
    const implementer = children.find((task) => task.contract.assignee?.role === 'implementer');
    const verifier = children.find((task) => task.contract.assignee?.role === 'verifier');
    assert.equal(implementer?.status, 'done');
    assert.equal(verifier?.status, 'awaiting_review');

    assert.ok(snapshot.summary, '生成汇总');
    assert.match(snapshot.summary!, /## 待你决策/);
    assert.match(snapshot.summary!, /## 未通过的检查/);
    assert.match(snapshot.summary!, /## 交付产物/);
    assert.match(snapshot.summary!, /ac_rubric/);
    assert.ok(snapshot.artifacts.length >= 2, 'diff 与校验报告都入库');
    assert.ok(snapshot.events.some((event) => event.type === 'worker.spawned'));
    assert.ok(snapshot.events.some((event) => event.type === 'runtime.finished'));
    assert.ok(snapshot.events.some((event) => event.type === 'summary.ready'));
    assert.ok(snapshot.workers.every((worker) => worker.cost.usd > 0));
    assert.ok(snapshot.events.some((event) => event.type === 'mandate.issued'));

    const effects = await call<{ sideEffects: Array<{ kind: string; state: string }> }>(
      `/api/tasks/${implementer!.id}/side-effects`,
    );
    assert.ok(
      effects.sideEffects.some(
        (effect) => effect.kind === 'fs.write' && effect.state === 'succeeded',
      ),
      '副作用台账记录并结算文件写入',
    );

    const openFor = (task: Task): Array<{ criterionId: string; verdict: 'passed'; note: string }> =>
      task.contract.acceptance_criteria
        .filter(
          (criterion) =>
            !snapshot!.acceptance.some(
              (record) =>
                record.taskId === task.id &&
                record.criterionId === criterion.id &&
                record.verdict === 'passed',
            ),
        )
        .map((criterion) => ({
          criterionId: criterion.id,
          verdict: 'passed' as const,
          note: 'e2e：人工确认结果符合目标',
        }));

    // 子任务先单独验收：verifier 完成后即可收口，不必等根任务。
    const verifierPending = openFor(verifier!);
    assert.ok(verifierPending.length > 0, 'verifier 有等待人工确认的验收项');
    const verifierDecided = await call<Task>(`/api/tasks/${verifier!.id}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({ decisions: verifierPending }),
    });
    assert.equal(verifierDecided.status, 'done');

    const afterChild = await call<WorkbenchSnapshot>('/api/bootstrap');
    assert.equal(
      afterChild.tasks.find((task) => task.id === planned.root.id)?.status,
      'awaiting_review',
      '子任务验收不会顺带放行根任务',
    );
    const rootBrief = afterChild.briefs.find((brief) => brief.taskId === planned.root.id);
    assert.ok(rootBrief, '根任务有决策说明');
    for (const field of ['changed', 'why', 'verified', 'risks'] as const) {
      assert.ok(rootBrief![field].trim(), `决策说明包含「${field}」`);
    }

    const rootTask = afterChild.tasks.find((task) => task.id === planned.root.id)!;
    const accepted = await call<Task>(`/api/tasks/${planned.root.id}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({ decisions: openFor(rootTask) }),
    });
    assert.equal(accepted.status, 'done');
    assert.ok(accepted.decidedAt, '验收动作写入 decided_at');

    const latency = await call<{ samples: number; decideLagP50: number | null }>(
      '/api/review-latency',
    );
    assert.ok(latency.samples >= 1, '反馈延迟有可统计样本');
    assert.ok(latency.decideLagP50 !== null, '可以算出 p50');

    const replay = await call<{ events: unknown[]; summary: string }>(
      `/api/tasks/${planned.root.id}/replay`,
    );
    assert.ok(replay.events.length > 0);
    assert.match(replay.summary, /## 交付产物/);
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
