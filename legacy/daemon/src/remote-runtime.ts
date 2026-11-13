import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectArtifacts,
  git,
  headOf,
  type HealthStatus,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type SessionOptions,
} from '@opencoxswain/adapters';
import type { RemoteJobView, RemoteService, RuntimeRegistry } from '@opencoxswain/plugin-api';
import {
  newId,
  now,
  type CostLedger,
  type TaskContract,
  type WorkerResult,
} from '@opencoxswain/shared';

const ZERO_COST: CostLedger = { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 };

class RemoteSession implements RuntimeSession {
  readonly id = newId('ses');
  cancelled = false;
  paused = false;
  result: WorkerResult | null = null;
  baseHead: string | null = null;
  branch = '';
  jobId: string | null = null;
  localSession: RuntimeSession | null = null;

  constructor(
    readonly taskId: string,
    readonly worktree: string,
    readonly options: SessionOptions,
  ) {}
}

export interface RemoteAdapterDeps {
  remote: RemoteService;
  /** 用于无节点时回退到本地运行时；为空表示不回退。 */
  runtimes: RuntimeRegistry;
  fallbackRuntime: string;
  jobTimeoutMs: number;
  claimTimeoutMs: number;
  /** 轮询远程任务状态的间隔。 */
  pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function artifactsRoot(options: SessionOptions): string {
  return (
    options.env.OPENCOXSWAIN_ARTIFACTS_DIR ??
    path.join(os.tmpdir(), 'opencoxswain-artifacts')
  );
}

/** 远程节点拿到的说明：只讲要做什么，不讲验收结论。 */
export function remotePrompt(task: TaskContract, options: SessionOptions): string {
  const lines = [
    `任务：${task.title}`,
    '',
    task.goal,
    '',
    `角色：${options.role.name}${options.role.readOnly ? '（只读，不要修改代码）' : ''}`,
    `工作分支：当前检出的分支，完成后必须把修改提交到该分支。`,
  ];
  if (task.constraints && task.constraints.length > 0) {
    lines.push('', '约束：', ...task.constraints.map((item) => `- ${item}`));
  }
  if (task.write_scope && task.write_scope.length > 0) {
    lines.push('', `允许改动的范围：${task.write_scope.join(', ')}`);
  }
  if (task.deliverables && task.deliverables.length > 0) {
    lines.push(
      '',
      '交付物：',
      ...task.deliverables.map((item) => `- ${item.type}${item.scope ? `：${item.scope}` : ''}`),
    );
  }
  lines.push(
    '',
    '注意：不要自行宣称任务已通过验收。验收由调度器在本地重新执行，节点上报的结论不会被采信。',
  );
  return lines.join('\n');
}

/**
 * 远程执行运行时：把任务分支打包给节点，节点完成后回传代码包，
 * 适配器把结果落回本地 worktree，再交给本地复核。
 *
 * 节点自报的验收与成本只是参考，不参与最终判定。
 */
export class RemoteRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'remote';
  readonly version = '0.1.0';
  readonly supportsApprovalGate = false;
  readonly capabilities = { input: false, approvalGate: false, resume: false };

  private readonly sessions = new Map<string, RemoteSession>();
  private readonly pollMs: number;

  constructor(private readonly deps: RemoteAdapterDeps) {
    this.pollMs = deps.pollMs ?? 500;
  }

  async healthCheck(): Promise<HealthStatus> {
    const status = this.deps.remote.status();
    const online = status.nodes.filter((node) => node.status !== 'offline').length;
    return {
      ok: status.enabled && online > 0,
      detail: status.enabled
        ? `${online} 个远程节点在线`
        : '远程执行未开启',
    };
  }

  async createSession(options: SessionOptions): Promise<RuntimeSession> {
    const branch = await git(options.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.code !== 0) {
      throw new Error(`无法识别任务分支：${branch.stderr.trim() || options.worktree}`);
    }
    const session = new RemoteSession(options.taskId, options.worktree, options);
    session.branch = branch.stdout.trim();
    session.baseHead = await headOf(options.worktree);
    this.sessions.set(session.id, session);
    return session;
  }

  async cancel(session: RuntimeSession): Promise<void> {
    const target = this.requireSession(session);
    target.cancelled = true;
    if (target.jobId) this.deps.remote.cancelJob(target.jobId);
    if (target.localSession) {
      const local = this.deps.runtimes.get(this.deps.fallbackRuntime);
      await local?.cancel(target.localSession);
    }
  }

  async collect(session: RuntimeSession): Promise<WorkerResult> {
    const target = this.requireSession(session);
    if (!target.result) throw new Error(`会话 ${session.id} 还没有结果`);
    return target.result;
  }

  async dispose(session: RuntimeSession): Promise<void> {
    this.sessions.delete(session.id);
  }

  async *send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const dir = path.join(artifactsRoot(session.options), task.task_id);
    await mkdir(dir, { recursive: true });
    const logsRef = path.join(dir, 'worker.log');
    await writeFile(logsRef, '');

    const log = async (event: RuntimeEvent): Promise<RuntimeEvent> => {
      await appendFile(logsRef, `${JSON.stringify(event)}\n`);
      return event;
    };

    yield await log({ type: 'started', at: now() });

    if (!this.deps.remote.isEnabled()) {
      if (this.deps.fallbackRuntime) {
        yield* this.runLocal(target, task, logsRef, '远程执行未开启', log);
        return;
      }
      yield await log({
        type: 'error',
        at: now(),
        message: '远程执行未开启，且未配置回退运行时',
        retryable: false,
      });
      return;
    }

    const bundlePath = path.join(
      artifactsRoot(session.options),
      'remote',
      `${session.id}.bundle`,
    );
    await mkdir(path.dirname(bundlePath), { recursive: true });
    const bundled = await git(session.worktree, ['bundle', 'create', bundlePath, target.branch]);
    if (bundled.code !== 0) {
      yield await log({
        type: 'error',
        at: now(),
        message: `代码打包失败：${bundled.stderr.trim().slice(0, 300)}`,
        retryable: true,
      });
      return;
    }

    const job = this.deps.remote.createJob({
      taskId: session.taskId,
      branch: target.branch,
      bundlePath,
      runtime: session.options.env.OPENCOXSWAIN_REMOTE_RUNTIME ?? 'opencode',
      model: session.options.model.model,
      prompt: remotePrompt(task, session.options),
      timeoutMs: this.deps.jobTimeoutMs,
    });
    target.jobId = job.id;
    yield await log({
      type: 'heartbeat',
      at: now(),
      phase: 'remote.queued',
      note: `远程任务 ${job.id} 已入队`,
    });

    const startedAt = Date.now();
    let assigned = false;
    let polled = 0;

    while (true) {
      if (target.cancelled) {
        this.deps.remote.cancelJob(job.id);
        return;
      }
      while (target.paused && !target.cancelled) {
        await delay(200);
      }
      const current = this.deps.remote.getJob(job.id);
      if (!current) {
        yield await log({
          type: 'error',
          at: now(),
          message: '远程任务记录丢失',
          retryable: true,
        });
        return;
      }

      if (current.status === 'assigned' && !assigned) {
        assigned = true;
        yield await log({
          type: 'progress',
          at: now(),
          percent: 20,
          note: `节点 ${current.nodeId ?? ''} 已认领，等待代码回传`,
        });
      }

      if (current.status === 'succeeded') {
        const synced = await this.syncBack(target, current, logsRef);
        if (!synced.ok) {
          yield await log({
            type: 'error',
            at: now(),
            message: synced.message,
            retryable: true,
          });
          return;
        }
        const artifacts = await collectArtifacts({
          worktree: session.worktree,
          baseHead: target.baseHead,
          task,
          roleName: session.options.role.name,
          acceptance: [],
          artifactsDir: dir,
        });
        for (const artifact of artifacts) {
          yield await log({ type: 'artifact', at: now(), artifact });
        }
        const result: WorkerResult = {
          summary: `${current.summary ?? '远程执行完成'}（代码已回传本地分支，等待本地复核）`,
          artifacts,
          // 节点自报的验收一律丢弃，由本地复核重新判定。
          acceptance: [],
          cost: current.cost ?? ZERO_COST,
          logsRef,
        };
        target.result = result;
        target.jobId = null;
        yield await log({ type: 'progress', at: now(), percent: 100, note: '代码已回传' });
        yield await log({ type: 'finished', at: now(), result });
        return;
      }

      if (current.status === 'failed' || current.status === 'expired' || current.status === 'cancelled') {
        target.jobId = null;
        yield await log({
          type: 'error',
          at: now(),
          message: current.error ?? `远程任务${current.status}`,
          retryable: current.status !== 'cancelled',
        });
        return;
      }

      const waited = Date.now() - startedAt;
      if (current.status === 'queued' && waited > this.deps.claimTimeoutMs) {
        this.deps.remote.cancelJob(job.id);
        target.jobId = null;
        if (this.deps.fallbackRuntime) {
          yield* this.runLocal(target, task, logsRef, '等待节点超时', log);
          return;
        }
        yield await log({
          type: 'error',
          at: now(),
          message: '等待远程节点认领超时',
          retryable: true,
        });
        return;
      }
      if (waited > this.deps.jobTimeoutMs + this.deps.claimTimeoutMs) {
        this.deps.remote.cancelJob(job.id);
        target.jobId = null;
        yield await log({
          type: 'error',
          at: now(),
          message: '远程执行超时',
          retryable: true,
        });
        return;
      }

      polled += 1;
      if (polled % 20 === 0) {
        yield await log({
          type: 'heartbeat',
          at: now(),
          phase: 'remote.waiting',
          note: `远程任务 ${current.status}`,
        });
      }
      await delay(this.pollMs);
    }
  }

  /** 把节点回传的分支拉到本地 worktree；拉不到就当失败处理，绝不采信「远程说完成了」。 */
  private async syncBack(
    session: RemoteSession,
    job: RemoteJobView,
    logsRef: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const bundle = this.deps.remote.resultBundlePath(job.id);
    if (!bundle) {
      return { ok: false, message: '节点未回传代码包' };
    }
    const fetched = await git(session.worktree, ['fetch', '--force', bundle, session.branch]);
    if (fetched.code !== 0) {
      return { ok: false, message: `回传代码无法读取：${fetched.stderr.trim().slice(0, 300)}` };
    }
    const reset = await git(session.worktree, ['reset', '--hard', 'FETCH_HEAD']);
    if (reset.code !== 0) {
      return { ok: false, message: `本地分支同步失败：${reset.stderr.trim().slice(0, 300)}` };
    }
    await appendFile(
      logsRef,
      `${JSON.stringify({
        type: 'message',
        at: now(),
        text: `已把节点 ${job.nodeId ?? ''} 的代码回传到本地分支 ${session.branch}，开始本地复核。`,
      })}\n`,
    );
    return { ok: true };
  }

  /** 无节点或远程未开启时退回本地运行时；复用同一份会话参数，避免环境漂移。 */
  private async *runLocal(
    session: RemoteSession,
    task: TaskContract,
    logsRef: string,
    reason: string,
    log: (event: RuntimeEvent) => Promise<RuntimeEvent>,
  ): AsyncIterable<RuntimeEvent> {
    const adapter = this.deps.runtimes.get(this.deps.fallbackRuntime);
    if (!adapter || adapter.name === this.name) {
      yield await log({
        type: 'error',
        at: now(),
        message: `${reason}，回退运行时不可用：${this.deps.fallbackRuntime}`,
        retryable: false,
      });
      return;
    }
    await appendFile(
      logsRef,
      `${JSON.stringify({
        type: 'message',
        at: now(),
        text: `${reason}，已回退到本地运行时 ${adapter.name}。`,
      })}\n`,
    );
    const local = await adapter.createSession(session.options);
    session.localSession = local;
    try {
      for await (const event of adapter.send(local, task)) {
        if (event.type === 'finished') session.result = event.result;
        if (event.type === 'error') session.result = null;
        yield await log(event);
      }
    } finally {
      session.localSession = null;
      await adapter.dispose(local);
    }
  }

  private requireSession(session: RuntimeSession): RemoteSession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`未知会话：${session.id}`);
    return target;
  }
}
