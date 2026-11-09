import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { OpenCodeRuntimeAdapter } from '../packages/adapters/dist/index.js';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const adapter = new OpenCodeRuntimeAdapter();
const health = await adapter.healthCheck();
if (!health.ok) {
  console.log(`跳过 OpenCode e2e：${health.detail}`);
  process.exit(0);
}
console.log(`OpenCode：${health.detail}`);

const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-opencode-'));
const repo = path.join(temp, 'repo');
const home = path.join(temp, 'home');
await mkdir(repo, { recursive: true });
await mkdir(home, { recursive: true });
await writeFile(path.join(repo, 'README.md'), '# demo\n', 'utf8');
git(repo, ['init', '-b', 'main']);
git(repo, ['config', 'user.name', 'OpenCoxswain E2E']);
git(repo, ['config', 'user.email', 'e2e@opencoxswain.local']);
git(repo, ['add', '-A']);
git(repo, ['commit', '-m', 'init']);

const task = {
  task_id: 'tsk_e2e_opencode',
  parent_id: null,
  project_id: 'prj_e2e',
  title: '写一条欢迎语',
  goal: '在当前目录创建 hello.txt，内容为一行 hello opencode，然后结束任务。',
  deliverables: [{ type: 'diff', scope: 'hello.txt' }],
  constraints: ['只允许修改 hello.txt'],
  acceptance_criteria: [{ id: 'ac_diff', type: 'diff', desc: 'hello.txt 有变更' }],
  dependencies: [],
  write_scope: ['hello.txt'],
  assignee: { role: 'implementer', runtime: 'opencode', model: '' },
  budget: { usd: 1, minutes: 10 },
  review: { required: false },
};

const session = await adapter.createSession({
  taskId: task.task_id,
  worktree: repo,
  role: {
    name: 'implementer',
    allowedTools: ['read', 'write', 'shell', 'test'],
    readOnly: false,
    outputSchema: 'worker-result.v1',
  },
  model: { provider: 'opencode', model: '', apiKeyRef: 'none', maxTokens: 32000 },
  approvalPolicy: { requireHumanFor: [] },
  env: { OPENCOXSWAIN_ARTIFACTS_DIR: path.join(home, 'artifacts') },
});

let result = null;
try {
  for await (const event of adapter.send(session, task)) {
    if (event.type === 'message') console.log(`[message] ${event.text}`);
    if (event.type === 'tool_call') console.log(`[tool] ${event.tool}`);
    if (event.type === 'error') console.error(`[error] ${event.message}`);
    if (event.type === 'finished') result = event.result;
  }
} finally {
  await adapter.dispose(session);
}

try {
  assert.ok(result, '应收到 finished 结果');
  const diff = result.artifacts.find((item) => item.type === 'diff');
  assert.ok(diff, '应产出 diff 产物');
  assert.equal(result.acceptance[0]?.status, 'passed', '验收应通过');
  console.log(`\n产物：${result.artifacts.map((item) => path.basename(item.path)).join(', ')}`);
  console.log(`成本：$${result.cost.usd} / ${result.cost.tokensIn} in / ${result.cost.tokensOut} out / ${result.cost.minutes} min`);
  console.log(`\n${git(repo, ['log', '--oneline']).trim()}`);
  console.log('\nOpenCode E2E 通过。');
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}
