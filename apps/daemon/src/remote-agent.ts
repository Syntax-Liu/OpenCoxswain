/**
 * 远程执行节点（骨架）。
 *
 * 节点主动连本机/局域网 daemon：注册 → 心跳领任务 → 拉代码包 → 执行 → 回传分支。
 * 节点不上报「验收通过」，验收固定由 daemon 在本地分支上重新执行。
 *
 * 用法：
 *   node dist/remote-agent.js --daemon http://192.168.1.10:47821 --token <接入令牌>
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RemoteJobView, RemoteRegistration } from '@opencoxswain/plugin-api';

interface NodeArgs {
  daemon: string;
  token: string;
  name: string;
  workdir: string;
  bin: string;
  once: boolean;
}

const MAX_LOG = 16_000;

function parseArgs(argv: string[]): NodeArgs {
  const options: Record<string, string> = {};
  let once = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item) continue;
    if (item === '--once') {
      once = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      options[item.slice(2)] = value;
      index += 1;
    }
  }
  const daemon = options.daemon ?? process.env.OPENCOXSWAIN_DAEMON ?? '';
  const token = options.token ?? process.env.OPENCOXSWAIN_NODE_TOKEN ?? '';
  if (daemon === '' || token === '') {
    throw new Error('必须提供 --daemon 与 --token（或 OPENCOXSWAIN_DAEMON / OPENCOXSWAIN_NODE_TOKEN）');
  }
  return {
    daemon: daemon.replace(/\/+$/, ''),
    token,
    name: options.name ?? process.env.OPENCOXSWAIN_NODE_NAME ?? os.hostname(),
    workdir: options.workdir ?? process.env.OPENCOXSWAIN_NODE_WORKDIR ?? path.join(os.tmpdir(), 'opencoxswain-node'),
    bin: options.bin ?? process.env.OPENCOXSWAIN_OPENCODE_BIN ?? 'opencode-cli',
    once,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capLog(text: string): string {
  return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}…` : text;
}

function run(
  command: string,
  args: string[],
  cwd: string | null,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd ?? undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      if (output.length < MAX_LOG) output += text;
      process.stdout.write(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === null) {
        reject(new Error(`${command} 被终止`));
        return;
      }
      resolve({ code, output });
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.workdir, { recursive: true });

  const call = async (
    url: string,
    init: { method?: string; token: string; json?: unknown; body?: Buffer } = { token: '' },
  ): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: `Bearer ${init.token}` };
    let body: Buffer | string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['Content-Type'] = 'application/octet-stream';
      body = init.body;
    }
    const response = await fetch(`${args.daemon}${url}`, {
      method: init.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(`${url} 返回 ${response.status}: ${capLog(await response.text())}`);
    }
    return response;
  };

  const registered = (await (
    await call('/api/remote/register', {
      token: args.token,
      json: { name: args.name, token: args.token, capabilities: ['git', 'opencode'] },
    })
  ).json()) as RemoteRegistration;
  console.log(`已注册为节点 ${args.name}（${registered.nodeId}）`);

  const nodeId = registered.nodeId;
  const nodeToken = registered.token;
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  const heartbeat = async (status: 'idle' | 'busy'): Promise<RemoteJobView | null> => {
    const response = await call(`/api/remote/nodes/${nodeId}/heartbeat`, {
      token: nodeToken,
      json: { status },
    });
    const body = (await response.json()) as { ok: boolean; job: RemoteJobView | null };
    return body.job;
  };

  const finish = async (job: RemoteJobView, payload: Record<string, unknown>): Promise<void> => {
    await call(`/api/remote/jobs/${job.id}/complete`, {
      token: nodeToken,
      json: { nodeId, ...payload },
    });
  };

  const execute = async (job: RemoteJobView): Promise<void> => {
    const dir = path.join(args.workdir, job.id);
    const input = path.join(args.workdir, `${job.id}.in.bundle`);
    const output = path.join(args.workdir, `${job.id}.out.bundle`);
    const prompt = path.join(args.workdir, `${job.id}.prompt.md`);
    // 执行期间仍要心跳：否则节点会被判离线，任务被转派给别的节点重复做一遍。
    const keepAlive = setInterval(() => {
      void heartbeat('busy').catch(() => undefined);
    }, Math.max(1_000, Math.floor(registered.heartbeatMs / 2)));
    let log = '';
    await rm(dir, { recursive: true, force: true });
    try {
      if (job.runtime !== 'opencode') {
        await finish(job, {
          ok: false,
          summary: '节点不支持该运行时',
          error: `节点只支持 opencode，收到 ${job.runtime}`,
          exitCode: 1,
          log: '',
        });
        return;
      }
      const bundle = Buffer.from(
        await (await call(`/api/remote/jobs/${job.id}/bundle?nodeId=${nodeId}`, { token: nodeToken })).arrayBuffer(),
      );
      await writeFile(input, bundle);
      await writeFile(prompt, job.prompt, 'utf8');
      const cloned = await run('git', ['clone', '--branch', job.branch, input, dir], null, 60_000);
      if (cloned.code !== 0) {
        await finish(job, {
          ok: false,
          summary: '代码包无法检出',
          error: cloned.output.slice(-800),
          exitCode: cloned.code,
          log: capLog(cloned.output),
        });
        return;
      }

      const modelArgs = job.model && !job.model.startsWith('mock-') ? ['--model', job.model] : [];
      const executed = await run(
        args.bin,
        ['run', '--standalone', '--format', 'json', ...modelArgs, job.prompt],
        dir,
        job.timeoutMs,
      );
      log = capLog(executed.output);
      if (executed.code !== 0) {
        await finish(job, {
          ok: false,
          summary: '远程执行失败',
          error: `执行器退出码 ${executed.code}`,
          exitCode: executed.code,
          log,
        });
        return;
      }

      const status = await run('git', ['status', '--porcelain'], dir, 30_000);
      if (status.output.trim() !== '') {
        const commit = await run(
          'git',
          [
            '-c',
            'user.name=OpenCoxswain',
            '-c',
            'user.email=coxswain@localhost',
            'commit',
            '-am',
            `远程执行：${job.taskId}`,
          ],
          dir,
          60_000,
        );
        if (commit.code !== 0) {
          await run('git', ['add', '-A'], dir, 30_000);
          const retried = await run(
            'git',
            [
              '-c',
              'user.name=OpenCoxswain',
              '-c',
              'user.email=coxswain@localhost',
              'commit',
              '-am',
              `远程执行：${job.taskId}`,
            ],
            dir,
            60_000,
          );
          if (retried.code !== 0) {
            await finish(job, {
              ok: false,
              summary: '代码提交失败',
              error: retried.output.slice(-800),
              exitCode: retried.code,
              log,
            });
            return;
          }
        }
      }
      const packed = await run('git', ['bundle', 'create', output, job.branch], dir, 120_000);
      if (packed.code !== 0) {
        await finish(job, {
          ok: false,
          summary: '代码打包失败',
          error: packed.output.slice(-800),
          exitCode: packed.code,
          log,
        });
        return;
      }
      const bytes = await readFile(output);
      await call(`/api/remote/jobs/${job.id}/result-bundle?nodeId=${nodeId}`, {
        token: nodeToken,
        body: bytes,
      });
      await finish(job, {
        ok: true,
        summary: `节点 ${args.name} 完成，代码已回传`,
        exitCode: 0,
        log,
      });
      console.log(`任务 ${job.taskId} 已完成并回传`);
    } catch (error) {
      await finish(job, {
        ok: false,
        summary: '远程执行异常',
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        log,
      }).catch(() => undefined);
    } finally {
      clearInterval(keepAlive);
      await rm(dir, { recursive: true, force: true });
      await rm(input, { force: true });
      await rm(output, { force: true });
      await rm(prompt, { force: true });
    }
  };

  while (!stopping) {
    try {
      const job = await heartbeat('idle');
      if (job) {
        console.log(`领取任务 ${job.taskId}（${job.id}）`);
        await execute(job);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`心跳失败：${message}`);
      if (/返回 401|返回 403/.test(message)) break;
    }
    if (args.once) break;
    await sleep(registered.heartbeatMs);
  }

  if (!stopping) console.log('节点已停止');
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
