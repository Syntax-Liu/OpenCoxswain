import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BuiltinRuntimeAdapter,
  type RuntimeEvent,
  type SessionOptions,
} from '@opencoxswain/adapters';
import type { TaskContract } from '@opencoxswain/shared';
import { runGit } from '../git.js';

interface FakeReply {
  message: Record<string, unknown>;
  usage?: Record<string, number>;
}

async function startFakeLlm(replies: FakeReply[]): Promise<{
  baseUrl: string;
  bodies: Array<Record<string, unknown>>;
  headers: Array<Record<string, string | string[] | undefined>>;
  close: () => Promise<void>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  let index = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        headers.push(req.headers);
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      const reply = replies[index] ?? {
        message: { role: 'assistant', content: '完成' },
      };
      index += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: reply.message, finish_reason: 'stop' }],
          usage: reply.usage ?? { prompt_tokens: 12, completion_tokens: 6 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('假模型服务器启动失败');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    headers,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-builtin-'));
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(repo, 'note.txt'), 'before\n', 'utf8');
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'init']);
  return repo;
}

function makeTask(): TaskContract {
  return {
    task_id: 'tsk_builtin_1',
    parent_id: null,
    project_id: 'prj_test',
    title: '实施：修改说明',
    goal: '把 note.txt 改成 after',
    deliverables: [{ type: 'diff' }],
    acceptance_criteria: [{ id: 'ac_diff', type: 'diff', desc: '产生了代码改动' }],
    dependencies: [],
    write_scope: ['note.txt'],
    budget: { tokens: 100_000, minutes: 10 },
  };
}

function makeOptions(repo: string, artifactsDir: string, task: TaskContract): SessionOptions {
  return {
    taskId: task.task_id,
    worktree: repo,
    role: {
      name: 'implementer',
      allowedTools: ['read_file', 'write_file', 'run_command'],
      readOnly: false,
      outputSchema: '',
    },
    model: { provider: 'test', model: 'test-model', apiKeyRef: '', maxTokens: 4096 },
    approvalPolicy: { requireHumanFor: [] },
    env: { OPENCOXSWAIN_ARTIFACTS_DIR: artifactsDir },
  };
}

test('内置执行体：调用工具写文件后提交并产生可复核的 diff', async () => {
  const repo = await makeRepo();
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-builtin-artifacts-'));
  const llm = await startFakeLlm([
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'note.txt', content: 'after\n' }),
            },
          },
        ],
      },
    },
    { message: { role: 'assistant', content: '已把 note.txt 改为 after。' } },
  ]);
  const adapter = new BuiltinRuntimeAdapter({
    resolve: async () => ({
      apiKey: 'test-key',
      baseUrl: llm.baseUrl,
      model: 'test-model',
    }),
  });
  try {
    const task = makeTask();
    const session = await adapter.createSession(makeOptions(repo, artifactsDir, task));
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.send(session, task)) events.push(event);
    const result = await adapter.collect(session);

    assert.equal(await readFile(path.join(repo, 'note.txt'), 'utf8'), 'after\n');
    assert.ok(events.some((event) => event.type === 'tool_call' && event.tool === 'write_file'));
    assert.equal(result.acceptance[0]?.status, 'passed', JSON.stringify(result.acceptance));
    assert.ok(result.artifacts.some((artifact) => artifact.type === 'diff'), '应产出 diff 产物');
    assert.equal(result.cost.tokensIn, 24);
    assert.equal(result.cost.tokensOut, 12);

    assert.equal(llm.bodies[0]?.model, 'test-model');
    assert.equal(llm.headers[0]?.authorization, 'Bearer test-key');
    const tools = llm.bodies[0]?.tools as Array<{ function?: { name?: string } }> | undefined;
    assert.ok(tools?.some((tool) => tool.function?.name === 'write_file'), '模型应看到写文件工具');
  } finally {
    await adapter.disposeAll();
    await llm.close();
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('内置执行体：没配置 Key 时给出明确错误而不是伪装成功', async () => {
  const repo = await makeRepo();
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-builtin-artifacts-'));
  const adapter = new BuiltinRuntimeAdapter({ resolve: async () => null });
  try {
    const health = await adapter.healthCheck();
    assert.equal(health.ok, false);
    assert.match(health.detail, /API Key/);

    const task = makeTask();
    const session = await adapter.createSession(makeOptions(repo, artifactsDir, task));
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.send(session, task)) events.push(event);
    const error = events.find((event) => event.type === 'error');
    assert.ok(error && error.type === 'error');
    assert.match(error.message, /API Key/);
    assert.equal(error.retryable, false);
    assert.ok(!events.some((event) => event.type === 'finished'));
  } finally {
    await adapter.disposeAll();
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    await rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
