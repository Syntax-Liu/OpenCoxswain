import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeRegistry } from '@opencoxswain/plugin-api';
import { MockRuntimeAdapter } from '@opencoxswain/adapters';
import type { TaskContract, WorkerResult } from '@opencoxswain/shared';
import { RemoteCoordinator } from '../remote.js';
import { RemoteRuntimeAdapter } from '../remote-runtime.js';
import { runGit } from '../git.js';
import { makeRepo } from './helpers.js';

function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: 'tsk_remote',
    parent_id: null,
    project_id: 'prj_remote',
    title: '远程改说明',
    goal: '把 note.txt 改成 after',
    deliverables: [{ type: 'diff', scope: 'note.txt' }],
    acceptance_criteria: [{ id: 'ac1', type: 'diff', desc: '说明被改动' }],
    dependencies: [],
    write_scope: ['note.txt'],
    budget: {},
    ...overrides,
  };
}

function registryOf(...adapters: MockRuntimeAdapter[]): RuntimeRegistry {
  return {
    register: () => () => undefined,
    get: (name: string) => adapters.find((adapter) => adapter.name === name),
    list: () => adapters,
    health: async () => ({ adapters: [], ok: true }),
  } as unknown as RuntimeRegistry;
}

function sessionOptions(worktree: string, taskId: string) {
  return {
    taskId,
    worktree,
    role: {
      name: 'implementer' as const,
      allowedTools: [],
      readOnly: false,
      outputSchema: 'patch',
    },
    model: { provider: 'local', model: 'mock', apiKeyRef: '', maxTokens: 4096 },
    approvalPolicy: { requireHumanFor: [] },
    env: {},
  };
}

test('远程默认关闭：注册被拒，开启后令牌校验生效', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-remote-'));
  try {
    const remote = new RemoteCoordinator({ homeDir: home });
    assert.equal(remote.isEnabled(), false);
    assert.throws(
      () => remote.register({ name: 'node-a', token: 'any' }),
      /远程执行未开启/,
    );

    const enabled = remote.enable();
    assert.equal(enabled.enabled, true);
    assert.ok(enabled.enrollmentToken.startsWith('rtk'));
    assert.throws(() => remote.register({ name: 'node-a', token: 'bad' }), /接入令牌无效/);

    const registration = remote.register({
      name: 'node-a',
      token: enabled.enrollmentToken,
      capabilities: ['git'],
    });
    // 心跳没有排队任务时不应凭空派活。
    const beat = remote.heartbeat(registration.nodeId, registration.token);
    assert.equal(beat.ok, true);
    assert.equal(beat.job, null);
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('远程执行：节点回传分支后由适配器同步到本地，验收结论不采信节点自报', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const extras = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-node-'));
  const remote = new RemoteCoordinator({ homeDir: fixture.home });
  remote.enable();
  const registration = remote.register({
    name: 'node-a',
    token: remote.status().enrollmentToken,
  });
  const adapter = new RemoteRuntimeAdapter({
    remote,
    runtimes: registryOf(),
    fallbackRuntime: '',
    jobTimeoutMs: 20_000,
    claimTimeoutMs: 20_000,
    pollMs: 10,
  });

  try {
    const contract = task();
    const session = await adapter.createSession(sessionOptions(fixture.repo, contract.task_id));
    const events: string[] = [];
    const out: { result: WorkerResult | null } = { result: null };
    const pump = (async () => {
      for await (const event of adapter.send(session, contract)) {
        events.push(event.type);
        if (event.type === 'finished') out.result = event.result;
      }
    })();

    // 假节点：领任务 → 下载代码包 → 改文件提交 → 回传代码包 → 上报完成。
    const queued = await waitJob(async () => {
      const job = remote.status().jobs.find((item) => item.status === 'queued');
      return job ?? null;
    });
    const beat = remote.heartbeat(registration.nodeId, registration.token);
    assert.equal(beat.job?.id, queued.id);
    assert.match(queued.prompt, /不会被采信/, '节点提示词必须说明验收不采信自报');

    const bundle = remote.bundlePath(queued.id);
    assert.ok(bundle, '协调器应保留待领取的代码包');
    const nodeRepo = path.join(extras, 'node-repo');
    const cloned = await runGit(extras, ['clone', '--branch', 'main', bundle, nodeRepo]);
    assert.equal(cloned.code, 0, cloned.stderr);
    await runGit(nodeRepo, ['config', 'user.name', 'Remote Node']);
    await runGit(nodeRepo, ['config', 'user.email', 'node@opencoxswain.local']);
    await writeFile(path.join(nodeRepo, 'note.txt'), 'after\n', 'utf8');
    await runGit(nodeRepo, ['add', '-A']);
    await runGit(nodeRepo, ['commit', '-m', '远程改说明']);

    const resultBundle = path.join(extras, 'result.bundle');
    const bundled = await runGit(nodeRepo, ['bundle', 'create', resultBundle, 'main']);
    assert.equal(bundled.code, 0, bundled.stderr);
    remote.storeResultBundle(queued.id, registration.nodeId, await readFile(resultBundle));
    remote.complete(queued.id, registration.nodeId, {
      ok: true,
      summary: '节点自称全部通过',
      exitCode: 0,
      log: 'ok',
      cost: { tokensIn: 10, tokensOut: 5, usd: 0.01, minutes: 1 },
    });

    await pump;
    const finished = out.result;
    assert.ok(finished, '适配器必须产出结果');
    assert.equal(finished.acceptance.length, 0, '节点自报的验收一律丢弃');
    assert.match(finished.summary, /本地复核/);
    assert.equal(
      (await readFile(path.join(fixture.repo, 'note.txt'), 'utf8')).trim(),
      'after',
    );
    assert.ok(events.includes('finished'));
    const collected = await adapter.collect(session);
    assert.equal(collected.summary, finished.summary);
    await adapter.dispose(session);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
    await rm(extras, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('远程未开启时按配置回退到本地运行时', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const remote = new RemoteCoordinator({ homeDir: fixture.home });
  const adapter = new RemoteRuntimeAdapter({
    remote,
    runtimes: registryOf(new MockRuntimeAdapter({ commandTimeoutMs: 20_000 })),
    fallbackRuntime: 'mock',
    jobTimeoutMs: 20_000,
    claimTimeoutMs: 20_000,
    pollMs: 10,
  });

  try {
    const contract = task({
      task_id: 'tsk_fallback',
      acceptance_criteria: [],
      inputs: { mock: { files: [{ path: 'note.txt', content: 'local\n' }] } },
    });
    const session = await adapter.createSession(sessionOptions(fixture.repo, contract.task_id));
    let result: WorkerResult | null = null;
    for await (const event of adapter.send(session, contract)) {
      if (event.type === 'finished') result = event.result;
    }
    const done = result;
    assert.ok(done);
    assert.equal(await readFile(path.join(fixture.repo, 'note.txt'), 'utf8'), 'local\n');
    await adapter.dispose(session);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function waitJob<T>(probe: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待远程任务超时');
}
