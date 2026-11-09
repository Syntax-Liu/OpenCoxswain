import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startDaemon } from '../apps/daemon/dist/app.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  }
}

function step(message) {
  console.log(`\n== ${message}`);
}

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
git(repo, ['init', '-b', 'main']);
git(repo, ['config', 'user.name', 'OpenCoxswain E2E']);
git(repo, ['config', 'user.email', 'e2e@opencoxswain.local']);
git(repo, ['add', '-A']);
git(repo, ['commit', '-m', 'init']);

step('启动 Daemon（临时 home）');
const app = await startDaemon({
  homeDir: home,
  dbPath: path.join(home, 'e2e.db'),
  worktreesDir: path.join(home, 'worktrees'),
  artifactsDir: path.join(home, 'artifacts'),
  port: 0,
});
const base = `http://127.0.0.1:${app.port}`;

const call = async (url, init) => {
  const response = await fetch(`${base}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
};

try {
  step('接入项目');
  const project = await call('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ path: repo, dailyBudgetUsd: 5 }),
  });
  console.log(`项目：${project.name}（${project.defaultBranch}）`);

  step('总管生成任务单');
  const planned = await call(`/api/projects/${project.id}/plan`, {
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
  console.log(`任务单：${planned.children.length} 个子任务，等待确认`);

  step('用户确认开工');
  await call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

  step('等待实施员与校验员完成');
  let snapshot = null;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    snapshot = await call('/api/bootstrap');
    const root = snapshot.tasks.find((task) => task.id === planned.root.id);
    if (root?.status === 'awaiting_review' || root?.status === 'failed') break;
    await delay(250);
  }
  const root = snapshot.tasks.find((task) => task.id === planned.root.id);
  assert.equal(root?.status, 'awaiting_review', `根任务状态：${root?.status}`);
  for (const task of snapshot.tasks) {
    console.log(`- ${task.title}：${task.status}`);
  }
  assert.ok(snapshot.summary, '应生成三块汇总');
  assert.ok(snapshot.artifacts.length >= 2, '应有 diff 与校验报告');

  step('读取产物');
  const artifact = snapshot.artifacts.find((item) => item.type === 'diff') ?? snapshot.artifacts[0];
  const content = await fetch(`${base}/api/artifacts/${artifact.id}`).then((res) => res.text());
  console.log(content.split('\n').slice(0, 8).join('\n'));

  step('用户验收');
  const accepted = await call(`/api/tasks/${planned.root.id}/accept`, { method: 'POST' });
  assert.equal(accepted.status, 'done');

  step('回放');
  const replay = await call(`/api/tasks/${planned.root.id}/replay`);
  assert.ok(replay.events.length > 0);
  console.log(`事件 ${replay.events.length} 条，汇总长度 ${replay.summary.length}`);
  console.log('\nE2E 通过。');
} finally {
  await app.close();
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
