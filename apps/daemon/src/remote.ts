import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  RemoteHeartbeat,
  RemoteJobInput,
  RemoteJobResult,
  RemoteJobStatus,
  RemoteJobView,
  RemoteNodeStatus,
  RemoteNodeView,
  RemoteRegistration,
  RemoteService,
  RemoteStatus,
} from '@opencoxswain/plugin-api';
import { newId, now } from '@opencoxswain/shared';
import { AppError } from './errors.js';

/** 节点心跳间隔；节点侧与状态展示共用同一份。 */
export const REMOTE_HEARTBEAT_MS = 10_000;
/** 连续错过 3 次心跳即视为离线，租约上的任务回到队列。 */
const OFFLINE_AFTER_MS = REMOTE_HEARTBEAT_MS * 3;
/** 同一个任务最多换 3 个节点，之后判定远程不可用。 */
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED = 50;
const MAX_LOG = 16_000;

interface StoredNode {
  id: string;
  name: string;
  token: string;
  capabilities: string[];
  status: RemoteNodeStatus;
  registeredAt: number;
  lastSeenAt: number;
  currentJobId: string | null;
}

interface StoredJob {
  id: string;
  taskId: string;
  status: RemoteJobStatus;
  nodeId: string | null;
  branch: string;
  runtime: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  attempts: number;
  createdAt: number;
  assignedAt: number | null;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  exitCode: number | null;
  log: string;
  cost: RemoteJobView['cost'];
  bundlePath: string;
  resultBundlePath: string | null;
}

interface RemoteState {
  enabled: boolean;
  enrollmentToken: string;
  nodes: StoredNode[];
  jobs: StoredJob[];
}

export interface RemoteDeps {
  /** 状态文件与代码包目录都放在这里。 */
  homeDir: string;
  /** 审计事件出口；只报状态变化，不搬运代码内容。 */
  notify?: (type: string, payload: unknown) => void;
  log?: (message: string, detail?: unknown) => void;
}

function blank(): RemoteState {
  return { enabled: false, enrollmentToken: '', nodes: [], jobs: [] };
}

function cleanLog(text: string): string {
  return text.length > MAX_LOG ? `${text.slice(0, MAX_LOG)}…` : text;
}

/**
 * 远程执行协调器。
 *
 * 设计约束：
 * - 默认关闭；开启需要显式动作，且节点必须持接入令牌注册。
 * - 节点主动连入，daemon 只被动接收，不对节点发起连接。
 * - 节点回传的代码包落到独立文件，由适配器取回本地分支后再由本地复核，
 *   节点自报的验收结论一律不采信。
 */
export class RemoteCoordinator implements RemoteService {
  private readonly filePath: string;
  private readonly bundlesDir: string;
  private state: RemoteState;

  constructor(private readonly deps: RemoteDeps) {
    this.filePath = path.join(deps.homeDir, 'remote-nodes.json');
    this.bundlesDir = path.join(deps.homeDir, 'remote');
    this.state = this.load();
  }

  status(): RemoteStatus {
    this.sweep();
    return {
      enabled: this.state.enabled,
      enrollmentToken: this.state.enabled ? this.state.enrollmentToken : '',
      heartbeatMs: REMOTE_HEARTBEAT_MS,
      nodes: this.state.nodes.map((node) => this.nodeView(node)),
      jobs: this.state.jobs
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((job) => this.jobView(job)),
    };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  enable(): RemoteStatus {
    if (!this.state.enabled) {
      this.state.enabled = true;
      if (this.state.enrollmentToken === '') {
        this.state.enrollmentToken = newId('rtk');
      }
      this.persist();
      this.deps.notify?.('remote.enabled', { at: now() });
    }
    return this.status();
  }

  disable(): RemoteStatus {
    if (this.state.enabled) {
      this.state.enabled = false;
      for (const node of this.state.nodes) {
        node.status = 'offline';
        node.currentJobId = null;
      }
      for (const job of this.state.jobs) {
        if (job.status === 'queued' || job.status === 'assigned') {
          job.status = 'cancelled';
          job.finishedAt = now();
          job.error = '远程执行已关闭';
          job.nodeId = null;
        }
      }
      this.persist();
      this.deps.notify?.('remote.disabled', { at: now() });
    }
    return this.status();
  }

  register(input: { name: string; token: string; capabilities?: string[] }): RemoteRegistration {
    if (!this.state.enabled) throw new AppError('远程执行未开启', 403);
    if (input.token !== this.state.enrollmentToken) {
      throw new AppError('接入令牌无效', 401);
    }
    const name = (input.name ?? '').trim();
    if (name === '') throw new AppError('节点名称不能为空');
    const at = now();
    const capabilities = (input.capabilities ?? []).map((item) => item.trim()).filter(Boolean);
    let node = this.state.nodes.find((item) => item.name === name);
    if (node) {
      // 同名节点视为重连：换发令牌并保留历史记录，避免节点表无限膨胀。
      node.token = newId('rnt');
      node.capabilities = capabilities;
      node.status = 'idle';
      node.lastSeenAt = at;
      node.currentJobId = null;
    } else {
      node = {
        id: newId('rnd'),
        name,
        token: newId('rnt'),
        capabilities,
        status: 'idle',
        registeredAt: at,
        lastSeenAt: at,
        currentJobId: null,
      };
      this.state.nodes.push(node);
    }
    this.persist();
    this.deps.notify?.('remote.node.registered', { nodeId: node.id, name: node.name });
    return { nodeId: node.id, token: node.token, heartbeatMs: REMOTE_HEARTBEAT_MS };
  }

  heartbeat(
    nodeId: string,
    token: string,
    input: { status?: 'idle' | 'busy' } = {},
  ): RemoteHeartbeat {
    const node = this.requireNode(nodeId, token);
    this.sweep();
    const at = now();
    node.lastSeenAt = at;
    if (node.status === 'offline') node.status = 'idle';

    let job = this.state.jobs.find((item) => item.id === node.currentJobId) ?? null;
    if (job && (job.status === 'succeeded' || job.status === 'failed')) {
      node.currentJobId = null;
      job = null;
    }
    if (!job && (input.status ?? 'idle') === 'idle') {
      job = this.assignNext(node, at);
    }
    node.status = job ? 'busy' : 'idle';
    this.persist();
    return { ok: true, job: job ? this.jobView(job) : null };
  }

  verifyNode(nodeId: string, token: string): boolean {
    if (nodeId === '' || token === '') return false;
    return this.state.nodes.some((node) => node.id === nodeId && node.token === token);
  }

  removeNode(id: string): boolean {
    const index = this.state.nodes.findIndex((node) => node.id === id);
    if (index < 0) return false;
    const [node] = this.state.nodes.splice(index, 1);
    if (node?.currentJobId) {
      const job = this.state.jobs.find((item) => item.id === node.currentJobId);
      if (job) this.requeue(job, '节点已被移除');
    }
    this.persist();
    return true;
  }

  createJob(input: RemoteJobInput): RemoteJobView {
    if (!this.state.enabled) throw new AppError('远程执行未开启', 403);
    this.sweep();
    const job: StoredJob = {
      id: newId('rjb'),
      taskId: input.taskId,
      status: 'queued',
      nodeId: null,
      branch: input.branch,
      runtime: input.runtime,
      model: input.model,
      prompt: input.prompt,
      timeoutMs: Math.max(10_000, input.timeoutMs),
      attempts: 0,
      createdAt: now(),
      assignedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
      exitCode: null,
      log: '',
      cost: null,
      bundlePath: input.bundlePath,
      resultBundlePath: null,
    };
    this.state.jobs.push(job);
    this.trim();
    this.persist();
    return this.jobView(job);
  }

  getJob(id: string): RemoteJobView | null {
    this.sweep();
    const job = this.state.jobs.find((item) => item.id === id);
    return job ? this.jobView(job) : null;
  }

  storeResultBundle(jobId: string, nodeId: string, data: Buffer): RemoteJobView {
    const job = this.requireHeldJob(jobId, nodeId);
    mkdirSync(this.bundlesDir, { recursive: true });
    const target = path.join(this.bundlesDir, `${job.id}.result.bundle`);
    writeFileSync(target, data);
    job.resultBundlePath = target;
    this.persist();
    return this.jobView(job);
  }

  complete(jobId: string, nodeId: string, result: RemoteJobResult): RemoteJobView {
    const job = this.requireHeldJob(jobId, nodeId);
    job.status = result.ok ? 'succeeded' : 'failed';
    job.summary = result.summary.slice(0, 2000);
    job.error = result.error ?? null;
    job.exitCode = Number.isFinite(result.exitCode) ? result.exitCode : null;
    job.log = cleanLog(result.log ?? '');
    job.cost = result.cost ?? null;
    job.finishedAt = now();
    const node = this.state.nodes.find((item) => item.id === nodeId);
    if (node) {
      node.currentJobId = null;
      node.status = 'idle';
    }
    this.trim();
    this.persist();
    this.deps.notify?.(
      job.status === 'succeeded' ? 'remote.job.succeeded' : 'remote.job.failed',
      { jobId: job.id, taskId: job.taskId, nodeId, error: job.error },
    );
    return this.jobView(job);
  }

  cancelJob(id: string): boolean {
    const job = this.state.jobs.find((item) => item.id === id);
    if (!job || (job.status !== 'queued' && job.status !== 'assigned')) return false;
    job.status = 'cancelled';
    job.finishedAt = now();
    job.error = '已取消';
    const node = this.state.nodes.find((item) => item.id === job.nodeId);
    if (node) {
      node.currentJobId = null;
      node.status = 'idle';
    }
    job.nodeId = null;
    this.persist();
    return true;
  }

  bundlePath(jobId: string): string | null {
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job || !existsSync(job.bundlePath)) return null;
    return job.bundlePath;
  }

  resultBundlePath(jobId: string): string | null {
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job || !job.resultBundlePath || !existsSync(job.resultBundlePath)) return null;
    return job.resultBundlePath;
  }

  sweep(at = now()): void {
    let changed = false;
    for (const node of this.state.nodes) {
      if (node.status !== 'offline' && at - node.lastSeenAt > OFFLINE_AFTER_MS) {
        node.status = 'offline';
        changed = true;
        this.deps.log?.(`节点离线：${node.name}`);
        this.deps.notify?.('remote.node.offline', { nodeId: node.id, name: node.name });
      }
    }
    for (const job of this.state.jobs) {
      if (job.status !== 'assigned' || job.assignedAt === null) continue;
      const node = this.state.nodes.find((item) => item.id === job.nodeId);
      const timedOut = at - job.assignedAt > job.timeoutMs;
      if (!node || node.status === 'offline' || timedOut) {
        this.requeue(job, timedOut ? '远程执行超时' : '节点离线');
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private assignNext(node: StoredNode, at: number): StoredJob | null {
    const job = this.state.jobs.find((item) => item.status === 'queued');
    if (!job) return null;
    if (!existsSync(job.bundlePath)) {
      job.status = 'failed';
      job.finishedAt = at;
      job.error = '代码包缺失，任务未派发';
      this.deps.notify?.('remote.job.failed', { jobId: job.id, error: job.error });
      return null;
    }
    job.status = 'assigned';
    job.nodeId = node.id;
    job.assignedAt = at;
    node.currentJobId = job.id;
    node.status = 'busy';
    this.deps.notify?.('remote.job.assigned', {
      jobId: job.id,
      taskId: job.taskId,
      nodeId: node.id,
    });
    return job;
  }

  private requeue(job: StoredJob, reason: string): void {
    const node = this.state.nodes.find((item) => item.id === job.nodeId);
    if (node) node.currentJobId = null;
    job.attempts += 1;
    job.nodeId = null;
    job.assignedAt = null;
    if (job.attempts >= MAX_ATTEMPTS) {
      job.status = 'expired';
      job.finishedAt = now();
      job.error = `远程执行不可用：${reason}`;
      this.deps.notify?.('remote.job.expired', { jobId: job.id, reason });
      return;
    }
    job.status = 'queued';
    this.deps.log?.(`任务回到队列：${job.id}（${reason}）`);
    this.deps.notify?.('remote.job.requeued', { jobId: job.id, reason, attempts: job.attempts });
  }

  private requireNode(nodeId: string, token: string): StoredNode {
    const node = this.state.nodes.find((item) => item.id === nodeId);
    if (!node || node.token !== token) throw new AppError('节点凭证无效', 401);
    return node;
  }

  private requireHeldJob(jobId: string, nodeId: string): StoredJob {
    this.sweep();
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job) throw new AppError('远程任务不存在', 404);
    if (job.nodeId !== nodeId || job.status !== 'assigned') {
      throw new AppError('远程任务已不在该节点名下', 409);
    }
    return job;
  }

  private nodeView(node: StoredNode): RemoteNodeView {
    return {
      id: node.id,
      name: node.name,
      status: node.status,
      capabilities: [...node.capabilities],
      registeredAt: node.registeredAt,
      lastSeenAt: node.lastSeenAt,
      currentJobId: node.currentJobId,
    };
  }

  private jobView(job: StoredJob): RemoteJobView {
    return {
      id: job.id,
      taskId: job.taskId,
      status: job.status,
      nodeId: job.nodeId,
      branch: job.branch,
      runtime: job.runtime,
      model: job.model,
      prompt: job.prompt,
      timeoutMs: job.timeoutMs,
      attempts: job.attempts,
      createdAt: job.createdAt,
      assignedAt: job.assignedAt,
      finishedAt: job.finishedAt,
      summary: job.summary,
      error: job.error,
      exitCode: job.exitCode,
      log: job.log,
      cost: job.cost,
    };
  }

  private trim(): void {
    const finished = this.state.jobs.filter(
      (job) => job.status !== 'queued' && job.status !== 'assigned',
    );
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(
      finished
        .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt))
        .slice(0, finished.length - KEEP_FINISHED)
        .map((job) => job.id),
    );
    this.state.jobs = this.state.jobs.filter((job) => !drop.has(job.id));
  }

  private load(): RemoteState {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RemoteState>;
      const state: RemoteState = {
        enabled: parsed.enabled === true,
        enrollmentToken: typeof parsed.enrollmentToken === 'string' ? parsed.enrollmentToken : '',
        nodes: Array.isArray(parsed.nodes) ? (parsed.nodes as StoredNode[]) : [],
        jobs: Array.isArray(parsed.jobs) ? (parsed.jobs as StoredJob[]) : [],
      };
      // 重启后节点需要重新心跳；租约上的任务回到队列，避免永久卡住。
      for (const node of state.nodes) {
        node.status = 'offline';
        node.currentJobId = null;
      }
      for (const job of state.jobs) {
        if (job.status === 'assigned') {
          job.status = 'queued';
          job.nodeId = null;
          job.assignedAt = null;
        }
      }
      return state;
    } catch {
      return blank();
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}
