import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../app.js';
import { runGit } from '../git.js';

const SUBTASKS = {
  subtasks: [
    {
      title: '实施：调整主题',
      goal: '把 theme.txt 改成 dark',
      role: 'implementer',
      dependsOn: [],
      writeScope: ['theme.txt'],
      acceptance: [{ id: 'ac1', type: 'command', desc: '检查通过', check: 'node check.mjs' }],
    },
    {
      title: '校验：调整主题',
      goal: '独立复跑检查',
      role: 'verifier',
      dependsOn: [0],
      acceptance: [{ id: 'ac1', type: 'command', desc: '检查通过', check: 'node check.mjs' }],
    },
  ],
};

test('模型配置：保存后真实调用、测试连接与失败原因可见', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-llm-'));
  const repo = path.join(temp, 'repo');
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(temp, 'home'), { recursive: true });
  await writeFile(path.join(repo, 'theme.txt'), 'light\n', 'utf8');
  await writeFile(path.join(repo, 'check.mjs'), 'console.log("ok")\n', 'utf8');
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'OpenCoxswain Test']);
  await runGit(repo, ['config', 'user.email', 'test@opencoxswain.local']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'init']);

  const calls: Array<{ model: string; authorization: string; json: boolean }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        response_format?: unknown;
      };
      calls.push({
        model: body.model,
        authorization: req.headers.authorization ?? '',
        json: body.response_format !== undefined,
      });
      const content = body.response_format ? JSON.stringify(SUBTASKS) : 'ok';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;

  const previous = process.env.OPENCOXSWAIN_LLM_API_KEY;
  process.env.OPENCOXSWAIN_LLM_API_KEY = 'sk-llm-test';
  const app = await startDaemon({
    homeDir: path.join(temp, 'home'),
    dbPath: path.join(temp, 'home', 'test.db'),
    worktreesDir: path.join(temp, 'home', 'worktrees'),
    artifactsDir: path.join(temp, 'home', 'artifacts'),
    port: 0,
  });
  const api = `http://127.0.0.1:${app.port}`;
  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${api}${url}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };

  try {
    const initial = await call<{
      config: { provider: string; baseUrl: string; model: string };
      key: { configured: boolean };
    }>('/api/llm');
    assert.equal(initial.config.provider, 'deepseek');
    assert.equal(initial.config.model, 'deepseek-chat');
    assert.equal(initial.key.configured, true);

    const saved = await call<{ config: { baseUrl: string; model: string } }>('/api/llm', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'custom', baseUrl, model: 'test-model' }),
    });
    assert.equal(saved.config.baseUrl, baseUrl);
    assert.equal(saved.config.model, 'test-model');

    const tested = await call<{ ok: boolean; error: string | null; model: string }>('/api/llm/test', {
      method: 'POST',
    });
    assert.equal(tested.ok, true, tested.error ?? '');
    assert.equal(tested.model, 'test-model');
    assert.equal(calls.at(-1)?.model, 'test-model');
    assert.equal(calls.at(-1)?.authorization, 'Bearer sk-llm-test');

    const project = await call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: repo }),
    });
    const planned = await call<{ root: { status: string }; children: Array<{ title: string }> }>(
      `/api/projects/${project.id}/plan`,
      { method: 'POST', body: JSON.stringify({ goal: '把主题改成 dark' }) },
    );
    assert.equal(planned.root.status, 'awaiting_approval');
    assert.equal(planned.children.length, 2);
    assert.equal(planned.children[0]?.title, '实施：调整主题');
    assert.equal(calls.at(-1)?.json, true, '规划请求要求 JSON 输出');

    const after = await call<{ lastError: unknown }>('/api/llm');
    assert.equal(after.lastError, null);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.OPENCOXSWAIN_LLM_API_KEY;
    else process.env.OPENCOXSWAIN_LLM_API_KEY = previous;
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('模型配置非法时拒绝保存', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-llm-'));
  const app = await startDaemon({
    homeDir: temp,
    dbPath: path.join(temp, 'test.db'),
    worktreesDir: path.join(temp, 'worktrees'),
    artifactsDir: path.join(temp, 'artifacts'),
    port: 0,
  });
  try {
    const badUrl = await fetch(`http://127.0.0.1:${app.port}/api/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'api.deepseek.com', model: 'deepseek-chat' }),
    });
    assert.equal(badUrl.status, 500);
    assert.match(await badUrl.text(), /http/);

    const badModel = await fetch(`http://127.0.0.1:${app.port}/api/llm`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: '  ' }),
    });
    assert.equal(badModel.status, 500);
    assert.match(await badModel.text(), /模型名/);
  } finally {
    await app.close();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
