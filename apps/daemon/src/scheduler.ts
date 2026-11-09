import { createHash } from 'node:crypto';
import {
  assertTransition,
  dependenciesOf,
  evaluateBudget,
  hasWriteConflict,
  readyTaskIds,
  type DagEdge,
  type DagTask,
  type TransitionActor,
} from '@opencoxswain/core';
import type {
  CostLedger,
  EventRecord,
  Project,
  RoleName,
  Task,
  TaskStatus,
  Worker,
  WorkerResult,
} from '@opencoxswain/shared';
import { emptyCost } from '@opencoxswain/core';
import type {
  ApprovalPolicy,
  ModelConfig,
  RoleTemplate,
  RuntimeAdapter,
  RuntimeSession,
} from '@opencoxswain/adapters';
import { EventBus } from './bus.js';
import type { DaemonConfig } from './config.js';
import { Store } from './store.js';
import { WorktreeManager } from './worktree.js';

interface ActiveRun {
  taskId: string;
  workerId: string;
  adapter: RuntimeAdapter;
  session: RuntimeSession;
  cancelled: boolean;
}

interface SchedulerHooks {
  onRootSettled?: (rootId: string) => void;
}

const ROLE_TEMPLATES: Record<RoleName, RoleTemplate> = {
  researcher: {
    name: 'researcher',
    allowedTools: ['read', 'web_search'],
    readOnly: true,
    outputSchema: 'worker-result.v1',
  },
  implementer: {
    name: 'implementer',
    allowedTools: ['read', 'write', 'shell', 'test'],
    readOnly: false,
    outputSchema: 'worker-result.v1',
  },
  verifier: {
    name: 'verifier',
    allowedTools: ['read', 'shell', 'test'],
    readOnly: true,
    outputSchema: 'worker-result.v1',
  },
  writer: {
    name: 'writer',
    allowedTools: ['read', 'write'],
    readOnly: false,
    outputSchema: 'worker-result.v1',
  },
};

const APPROVAL_POLICY: ApprovalPolicy = {
  requireHumanFor: ['delete', 'push', 'publish', 'pay', 'external_send'],
};

const SETTLED: TaskStatus[] = ['done', 'awaiting_review', 'failed', 'cancelled'];

export interface SchedulerOptions {
  store: Store;
  bus: EventBus;
  config: DaemonConfig;
  adapters: Map<string, RuntimeAdapter>;
  worktrees: WorktreeManager;
}

export class Scheduler {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly config: DaemonConfig;
  private readonly adapters: Map<string, RuntimeAdapter>;
  private readonly worktrees: WorktreeManager;
  private readonly active = new Map<string, ActiveRun>();
  private readonly dispatching = new Set<string>();
  private readonly budgetNotified = new Set<string>();
  private hooks: SchedulerHooks = {};
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.config = options.config;
    this.adapters = options.adapters;
    this.worktrees = options.worktrees;
  }

  setHooks(hooks: SchedulerHooks): void {
    this.hooks = hooks;
  }

  start(): void {
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, 350);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const run of this.active.values()) {
      await run.adapter.cancel(run.session).catch(() => undefined);
    }
  }

  async pause(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) return;
    if (run.adapter.pause) await run.adapter.pause(run.session);
    this.store.updateWorker(run.workerId, { status: 'paused' });
    this.emit(taskId, run.workerId, 'worker.status', { status: 'paused' });
  }

  async resume(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) return;
    if (run.adapter.resume) await run.adapter.resume(run.session);
    this.store.updateWorker(run.workerId, { status: 'running' });
    this.emit(taskId, run.workerId, 'worker.status', { status: 'running' });
  }

  async cancel(taskId: string): Promise<void> {
    const run = this.active.get(taskId);
    if (!run) return;
    run.cancelled = true;
    await run.adapter.cancel(run.session).catch(() => undefined);
    this.store.updateWorker(run.workerId, { status: 'terminated' });
    this.emit(taskId, run.workerId, 'worker.status', { status: 'terminated' });
  }

  private recover(): void {
    for (const project of this.store.listProjects()) {
      for (const task of this.store.listTasks(project.id)) {
        if (task.status === 'running') {
          this.store.setTaskStatus(task.id, 'blocked');
          this.emit(task.id, null, 'task.recovered', {
            message: 'Daemon 重启，执行现场已保留；请检查后取消或重试。',
          });
        }
        const worker = this.store.getWorkerByTask(task.id);
        if (worker && (worker.status === 'starting' || worker.status === 'running')) {
          this.store.updateWorker(worker.id, { status: 'failed' });
        }
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const project of this.store.listProjects()) {
        await this.tickProject(project);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickProject(project: Project): Promise<void> {
    let tasks = this.store.listTasks(project.id);
    const edges = this.store.listEdges(project.id);
    this.settleRoots(tasks);
    tasks = this.store.listTasks(project.id);

    if (this.active.size >= this.config.maxConcurrency) return;
    const projectActive = [...this.active.values()].filter((run) => {
      const task = this.store.getTask(run.taskId);
      return task?.projectId === project.id;
    }).length;
    if (projectActive >= project.maxConcurrency) return;

    const dailyCost = this.store.sumProjectCostSince(project.id, startOfDay());
    if (dailyCost >= project.dailyBudgetUsd) {
      const key = `${project.id}:${startOfDay()}`;
      if (!this.budgetNotified.has(key)) {
        this.budgetNotified.add(key);
        this.emit(null, null, 'budget.exceeded', {
          projectId: project.id,
          scope: 'daily',
          used: dailyCost,
          limit: project.dailyBudgetUsd,
        });
      }
      return;
    }

    const running = tasks.filter(
      (task) => task.status === 'running' && task.assigneeId !== null,
    );
    const runningDag: DagTask[] = running.map((task) => ({
      id: task.id,
      status: task.status,
      writeScope: task.contract.write_scope ?? [],
      readOnly: isReadOnly(task),
      createdAt: task.createdAt,
    }));

    const readyDag: DagTask[] = tasks
      .filter((task) => task.assigneeId === null || task.parentId !== null)
      .map((task) => ({
        id: task.id,
        status: task.status === 'awaiting_review' ? 'done' : task.status,
        writeScope: task.contract.write_scope ?? [],
        readOnly: isReadOnly(task),
        createdAt: task.createdAt,
      }));
    const readyIds = new Set(readyTaskIds(readyDag, edges as DagEdge[]));

    for (const task of tasks) {
      if (!readyIds.has(task.id)) continue;
      if (task.parentId === null) continue;
      if (this.dispatching.has(task.id) || this.active.has(task.id)) continue;
      if (this.active.size >= this.config.maxConcurrency) break;
      if (this.activeForProject(project.id) >= project.maxConcurrency) break;

      const candidate: DagTask = {
        id: task.id,
        status: task.status,
        writeScope: task.contract.write_scope ?? [],
        readOnly: isReadOnly(task),
        createdAt: task.createdAt,
      };
      if (hasWriteConflict(candidate, runningDag)) continue;

      const cost = this.store.sumTaskCost(task.id);
      const budget = evaluateBudget(task.contract.budget, cost);
      if (budget.status === 'exceeded') {
        this.blockTask(task, budget.reasons.join('；'));
        continue;
      }

      await this.spawn(project, task, edges);
    }
  }

  private settleRoots(tasks: Task[]): void {
    for (const root of tasks) {
      if (root.parentId !== null || root.status !== 'running') continue;
      const children = this.store.listChildren(root.id);
      if (children.length === 0) continue;
      if (!children.every((child) => SETTLED.includes(child.status))) continue;
      this.transition(root.id, 'awaiting_review', 'scheduler');
      this.hooks.onRootSettled?.(root.id);
    }
  }

  private async spawn(project: Project, task: Task, edges: DagEdge[]): Promise<void> {
    this.dispatching.add(task.id);
    const assignee = task.contract.assignee;
    if (!assignee) {
      this.dispatching.delete(task.id);
      this.fail(task.id, null, '任务没有指定执行角色');
      return;
    }
    const adapter = this.adapters.get(assignee.runtime);
    if (!adapter) {
      this.dispatching.delete(task.id);
      this.fail(task.id, null, `未注册运行时：${assignee.runtime}`);
      return;
    }

    let baseRef: string | undefined;
    for (const dependency of dependenciesOf(task.id, edges)) {
      const worker = this.store.getWorkerByTask(dependency);
      if (worker?.branch) baseRef = worker.branch;
    }

    let worktree: { path: string; branch: string };
    try {
      worktree = await this.worktrees.create(project, task, baseRef);
    } catch (error) {
      this.dispatching.delete(task.id);
      this.fail(task.id, null, error instanceof Error ? error.message : String(error));
      return;
    }

    const worker: Worker = {
      id: `wrk_${task.id.slice(4, 16)}`,
      taskId: task.id,
      role: assignee.role,
      runtime: assignee.runtime,
      model: assignee.model,
      worktreePath: worktree.path,
      branch: worktree.branch,
      sessionRef: null,
      status: 'starting',
      cost: emptyCost(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.insertWorker(worker);
    this.store.setTaskAssignee(task.id, worker.id);
    this.transition(task.id, 'running', 'scheduler');
    this.emit(task.id, worker.id, 'worker.spawned', {
      role: worker.role,
      model: worker.model,
      branch: worker.branch,
      worktree: worker.worktreePath,
    });
    this.store.insertRun(`run_${worker.id.slice(4, 16)}`, worker.id, 1);

    void this.run(task, worker, adapter);
  }

  private async run(task: Task, worker: Worker, adapter: RuntimeAdapter): Promise<void> {
    let session: RuntimeSession | null = null;
    let result: WorkerResult | null = null;
    let errorMessage: string | null = null;
    const runId = `run_${worker.id.slice(4, 16)}`;
    try {
      session = await adapter.createSession({
        taskId: task.id,
        worktree: worker.worktreePath,
        role: ROLE_TEMPLATES[worker.role],
        model: modelConfig(worker.model),
        approvalPolicy: APPROVAL_POLICY,
        env: { OPENCOXSWAIN_ARTIFACTS_DIR: this.config.artifactsDir },
      });
      const run: ActiveRun = {
        taskId: task.id,
        workerId: worker.id,
        adapter,
        session,
        cancelled: false,
      };
      this.active.set(task.id, run);
      this.store.updateWorker(worker.id, { status: 'running', sessionRef: session.id });
      this.emit(task.id, worker.id, 'worker.status', { status: 'running' });

      for await (const event of adapter.send(session, task.contract)) {
        const current = this.store.getTask(task.id);
        if (run.cancelled || current?.status === 'cancelled') {
          await adapter.cancel(session);
          break;
        }
        this.emit(task.id, worker.id, `runtime.${event.type}`, event);

        if (event.type === 'finished') {
          result = event.result;
          await this.finish(task, worker, event.result);
          break;
        }
        if (event.type === 'error') {
          errorMessage = event.message;
          this.fail(task.id, worker.id, event.message);
          break;
        }
      }

      if (!result && !errorMessage) {
        errorMessage = '员工结束但没有返回结果';
        this.fail(task.id, worker.id, errorMessage);
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      this.emit(task.id, worker.id, 'runtime.error', {
        type: 'error',
        at: Date.now(),
        message: errorMessage,
        retryable: false,
      });
      this.fail(task.id, worker.id, errorMessage);
    } finally {
      if (session) await adapter.dispose(session).catch(() => undefined);
      this.store.finishRun(runId, result, errorMessage);
      this.active.delete(task.id);
      this.dispatching.delete(task.id);
    }
  }

  private async finish(task: Task, worker: Worker, result: WorkerResult): Promise<void> {
    this.store.insertModelCall({ workerId: worker.id, model: worker.model, cost: result.cost });
    this.store.updateWorker(worker.id, { status: 'done', cost: result.cost });
    this.store.setAcceptance(task.id, result.acceptance);

    for (const artifact of result.artifacts) {
      this.store.insertArtifact({
        taskId: task.id,
        type: artifact.type,
        path: artifact.path,
        hash: createHash('sha256')
          .update(`${artifact.path}:${artifact.meta?.additions ?? 0}:${artifact.meta?.deletions ?? 0}`)
          .digest('hex'),
        meta: artifact.meta,
      });
    }

    this.emit(task.id, worker.id, 'worker.finished', {
      summary: result.summary,
      cost: result.cost,
      artifacts: result.artifacts.length,
    });

    const failed = result.acceptance.some((item) => item.status === 'failed');
    const unverified = result.acceptance.some((item) => item.status === 'unverified');
    const current = this.store.getTask(task.id);
    if (!current || current.status !== 'running') return;

    const next: TaskStatus = failed ? 'failed' : unverified ? 'awaiting_review' : 'done';
    this.transition(task.id, next, 'scheduler');
  }

  private fail(taskId: string, workerId: string | null, message: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    if (workerId) {
      const worker = this.store.getWorker(workerId);
      if (worker) this.store.updateWorker(workerId, { status: 'failed' });
      this.emit(taskId, workerId, 'worker.failed', { message });
    }
    if (task.status === 'running' || task.status === 'queued') {
      this.transition(taskId, 'failed', 'scheduler');
    }
  }

  private blockTask(task: Task, reason: string): void {
    this.emit(task.id, null, 'budget.exceeded', {
      scope: 'task',
      reason,
      budget: task.contract.budget,
    });
    if (task.status === 'queued') {
      this.transition(task.id, 'running', 'scheduler');
    }
    this.transition(task.id, 'blocked', 'scheduler');
  }

  private transition(taskId: string, to: TaskStatus, actor: TransitionActor): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    assertTransition(task.status, to, actor);
    this.store.setTaskStatus(taskId, to);
    this.emit(taskId, null, 'task.status_changed', { from: task.status, to, actor });
  }

  private activeForProject(projectId: string): number {
    let count = 0;
    for (const run of this.active.values()) {
      const task = this.store.getTask(run.taskId);
      if (task?.projectId === projectId) count += 1;
    }
    return count;
  }

  private emit(
    taskId: string | null,
    workerId: string | null,
    type: string,
    payload: unknown,
  ): EventRecord {
    const event = this.store.appendEvent({ taskId, workerId, type, payload });
    this.bus.publish(event);
    return event;
  }
}

function isReadOnly(task: Task): boolean {
  const role = task.contract.assignee?.role;
  return role === 'verifier' || role === 'researcher';
}

function modelConfig(model: string): ModelConfig {
  return {
    provider: 'mock',
    model,
    apiKeyRef: 'none',
    maxTokens: 32_000,
    temperature: 0.2,
  };
}

function startOfDay(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
