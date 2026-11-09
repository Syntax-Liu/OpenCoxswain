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
  Approval,
  CostLedger,
  EmployeeDefinition,
  EventRecord,
  Project,
  Task,
  TaskStatus,
  Worker,
  WorkerResult,
} from '@opencoxswain/shared';
import { addCost, emptyCost } from '@opencoxswain/core';
import { newId } from '@opencoxswain/shared';
import type {
  ActionRequest,
  ApprovalGate,
  ApprovalPolicy,
  ModelConfig,
  RoleTemplate,
  RuntimeAdapter,
  RuntimeSession,
} from '@opencoxswain/adapters';
import { actionKey, classifyAction } from '@opencoxswain/adapters';
import type {
  EmployeeRegistry,
  EventService,
  OpenCoxswainConfig,
  RuntimeRegistry,
  StorageService,
  VerificationService,
  WorktreeService,
} from '@opencoxswain/plugin-api';
import { MergeConflictError } from './worktree.js';

interface ActiveRun {
  taskId: string;
  workerId: string;
  adapter: RuntimeAdapter;
  session: RuntimeSession;
  cancelled: boolean;
  liveCost: CostLedger;
  warned: boolean;
}

const APPROVAL_POLICY: ApprovalPolicy = {
  requireHumanFor: ['delete', 'push', 'publish', 'pay', 'external_send'],
};

const SETTLED: TaskStatus[] = ['done', 'awaiting_review', 'failed', 'cancelled'];

/** 可重试错误的最大尝试次数（含首次）。 */
const MAX_ATTEMPTS = 2;

export interface SchedulerOptions {
  store: StorageService;
  bus: EventService;
  config: OpenCoxswainConfig;
  runtimes: RuntimeRegistry;
  worktrees: WorktreeService;
  employees: EmployeeRegistry;
  verification: VerificationService;
}

export class Scheduler {
  private readonly store: StorageService;
  private readonly bus: EventService;
  private readonly config: OpenCoxswainConfig;
  private readonly runtimes: RuntimeRegistry;
  private readonly worktrees: WorktreeService;
  private readonly employees: EmployeeRegistry;
  private readonly verification: VerificationService;
  private readonly active = new Map<string, ActiveRun>();
  private readonly running = new Set<Promise<void>>();
  private readonly dispatching = new Set<string>();
  private readonly budgetNotified = new Set<string>();
  private readonly taskWarned = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopping = false;

  constructor(options: SchedulerOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.config = options.config;
    this.runtimes = options.runtimes;
    this.worktrees = options.worktrees;
    this.employees = options.employees;
    this.verification = options.verification;
  }

  start(): void {
    this.stopping = false;
    this.recover();
    this.timer = setInterval(() => {
      void this.tick();
    }, 350);
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const run of this.active.values()) {
      await run.adapter.cancel(run.session).catch(() => undefined);
    }
    // 等所有执行中的 run 落到 finally，避免关闭数据库后仍有异步写入。
    await Promise.allSettled([...this.running]);
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
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const project of this.store.listProjects()) {
        if (this.stopping) break;
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

    const dailyCost =
      this.store.sumProjectCostSince(project.id, startOfDay()) + this.liveProjectCost(project.id);
    if (dailyCost >= project.dailyBudgetUsd) {
      const key = `${project.id}:${startOfDay()}`;
      const first = !this.budgetNotified.has(key);
      if (first) this.budgetNotified.add(key);
      await this.abortProjectRuns(project, dailyCost, first);
      return;
    }

    const running = tasks.filter(
      (task) => task.status === 'running' && task.assigneeId !== null,
    );
    const runningDag: DagTask[] = running.map((task) => ({
      id: task.id,
      status: task.status,
      writeScope: task.contract.write_scope ?? [],
      readOnly: this.isReadOnly(task),
      createdAt: task.createdAt,
    }));

    const readyDag: DagTask[] = tasks
      .filter((task) => task.assigneeId === null || task.parentId !== null)
      .map((task) => ({
        id: task.id,
        status: task.status === 'awaiting_review' ? 'done' : task.status,
        writeScope: task.contract.write_scope ?? [],
        readOnly: this.isReadOnly(task),
        createdAt: task.createdAt,
      }));
    const readyIds = new Set(readyTaskIds(readyDag, edges as DagEdge[]));

    for (const task of tasks) {
      if (this.stopping) return;
      if (!readyIds.has(task.id)) continue;
      if (task.parentId === null) continue;
      if (this.dispatching.has(task.id) || this.active.has(task.id)) continue;
      if (this.active.size >= this.config.maxConcurrency) break;
      if (this.activeForProject(project.id) >= project.maxConcurrency) break;

      const candidate: DagTask = {
        id: task.id,
        status: task.status,
        writeScope: task.contract.write_scope ?? [],
        readOnly: this.isReadOnly(task),
        createdAt: task.createdAt,
      };
      if (hasWriteConflict(candidate, runningDag)) continue;

      const cost = this.store.sumTaskCost(task.id);
      const budget = evaluateBudget(task.contract.budget, cost);
      if (budget.status === 'warning') this.warnTaskBudget(task, budget.reasons.join('；'));
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
      this.bus.emit('root.settled', { rootId: root.id });
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
    const adapter = this.runtimes.get(assignee.runtime);
    if (!adapter) {
      this.dispatching.delete(task.id);
      this.fail(task.id, null, `未注册运行时：${assignee.runtime}`);
      return;
    }
    const employee = this.employees.get(assignee.role);
    if (!employee) {
      this.dispatching.delete(task.id);
      this.fail(
        task.id,
        null,
        `未安装角色为 ${assignee.role} 的员工插件包，无法派单`,
      );
      return;
    }

    const baseRefs: string[] = [];
    for (const dependency of dependenciesOf(task.id, edges)) {
      const worker = this.store.getWorkerByTask(dependency);
      if (worker?.branch && !baseRefs.includes(worker.branch)) baseRefs.push(worker.branch);
    }

    let worktree: { path: string; branch: string };
    try {
      worktree = await this.worktrees.create(project, task, baseRefs);
    } catch (error) {
      this.dispatching.delete(task.id);
      if (error instanceof MergeConflictError) {
        this.requestMergeReview(task, baseRefs, error);
      } else {
        this.fail(task.id, null, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const worker: Worker = {
      id: newId('wrk'),
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
      employee: employee.id,
      employeePlugin: employee.pluginId,
      model: worker.model,
      branch: worker.branch,
      worktree: worker.worktreePath,
    });
    const runId = newId('run');
    this.store.insertRun(runId, worker.id, 1);

    const pending = this.run(task, worker, employee, adapter, runId);
    this.running.add(pending);
    void pending.finally(() => this.running.delete(pending));
  }

  private async run(
    task: Task,
    worker: Worker,
    employee: EmployeeDefinition,
    adapter: RuntimeAdapter,
    runId: string,
  ): Promise<void> {
    let session: RuntimeSession | null = null;
    let result: WorkerResult | null = null;
    let errorMessage: string | null = null;
    let aborted = false;
    let retryable = false;
    let attempt = 0;
    let pendingRunId: string | null = runId;
    try {
      for (;;) {
        if (this.stopping) break;
        attempt += 1;
        session = await adapter.createSession({
          taskId: task.id,
          worktree: worker.worktreePath,
          role: roleTemplate(employee),
          model: modelConfig(worker.runtime, worker.model),
          approvalPolicy: APPROVAL_POLICY,
          env: { OPENCOXSWAIN_ARTIFACTS_DIR: this.config.artifactsDir },
          gate: this.createGate(task, worker),
        });
        const run: ActiveRun = {
          taskId: task.id,
          workerId: worker.id,
          adapter,
          session,
          cancelled: false,
          liveCost: emptyCost(),
          warned: false,
        };
        this.active.set(task.id, run);
        this.store.updateWorker(worker.id, { status: 'running', sessionRef: session.id });
        this.emit(task.id, worker.id, 'worker.status', { status: 'running' });

        for await (const event of adapter.send(session, task.contract)) {
          const current = this.store.getTask(task.id);
          if (run.cancelled || current?.status === 'cancelled') {
            await adapter.cancel(session);
            aborted = true;
            break;
          }
          this.emit(task.id, worker.id, `runtime.${event.type}`, event);

          if (event.type === 'cost') {
            run.liveCost = addCost(run.liveCost, event.cost);
            this.store.updateWorker(worker.id, { cost: run.liveCost });
            if (await this.enforceTaskBudget(task, worker, run)) {
              aborted = true;
              await adapter.cancel(session);
              break;
            }
            continue;
          }

          if (event.type === 'tool_call' && !adapter.supportsApprovalGate) {
            const category = classifyAction(event.tool, event.input);
            if (category && !this.hasApprovedAction(task, event.tool, event.input)) {
              this.requestApproval(task, worker, {
                tool: event.tool,
                input: event.input,
                category,
              });
              this.flushLiveCost(worker, run);
              await adapter.cancel(session);
              this.emit(task.id, worker.id, 'worker.frozen', {
                reason: 'dangerous_action',
                tool: event.tool,
                category,
              });
              this.fail(
                task.id,
                worker.id,
                `危险动作（${category}）已冻结：批准后任务会重新排队执行。`,
              );
              aborted = true;
              break;
            }
          }

          if (event.type === 'finished') {
            result = event.result;
            break;
          }
          if (event.type === 'error') {
            errorMessage = event.message;
            retryable = event.retryable;
            break;
          }
        }

        if (result) {
          await this.finish(task, worker, result);
          break;
        }

        await adapter.dispose(session).catch(() => undefined);
        session = null;
        this.active.delete(task.id);

        if (aborted || run.cancelled) break;
        if (!errorMessage) errorMessage = '员工结束但没有返回结果';

        this.flushLiveCost(worker, run);
        run.liveCost = emptyCost();

        if (retryable && attempt < MAX_ATTEMPTS) {
          if (pendingRunId) this.store.finishRun(pendingRunId, null, errorMessage);
          pendingRunId = newId('run');
          this.store.insertRun(pendingRunId, worker.id, attempt + 1);
          this.emit(task.id, worker.id, 'worker.retrying', {
            attempt: attempt + 1,
            message: errorMessage,
          });
          this.store.updateWorker(worker.id, { status: 'starting' });
          errorMessage = null;
          retryable = false;
          await delay(300);
          continue;
        }

        this.fail(task.id, worker.id, errorMessage);
        if (!errorMessage.includes('危险动作被拒绝')) {
          this.escalate(task, worker, errorMessage, retryable);
        }
        break;
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
      this.escalate(task, worker, errorMessage, false);
    } finally {
      if (session) await adapter.dispose(session).catch(() => undefined);
      if (pendingRunId) this.store.finishRun(pendingRunId, result, errorMessage);
      this.active.delete(task.id);
      this.dispatching.delete(task.id);
    }
  }

  private escalate(
    task: Task,
    worker: Worker,
    message: string,
    retryable: boolean,
  ): void {
    this.emit(task.id, worker.id, 'task.escalated', {
      reason: retryable ? 'retry_exhausted' : 'runtime_error',
      message,
    });
    this.store.insertMessage({
      projectId: task.projectId,
      role: 'assistant',
      content: [
        '## 待你决策',
        retryable
          ? `任务「${task.title}」自动重试 ${MAX_ATTEMPTS} 次后仍失败：`
          : `任务「${task.title}」执行失败：`,
        `- ${message}`,
        `- 修好后调用 POST /api/tasks/${task.id}/retry 重新执行，或取消任务。`,
      ].join('\n'),
    });
  }

  private requestMergeReview(
    task: Task,
    refs: string[],
    error: MergeConflictError,
  ): void {
    const approval = this.store.insertApproval({
      taskId: task.id,
      type: 'merge_conflict',
      requestedBy: 'scheduler',
      payload: { refs, detail: error.message },
    });
    this.emit(task.id, null, 'merge.conflict', {
      approvalId: approval.id,
      refs,
      detail: error.message,
    });
    this.store.insertMessage({
      projectId: task.projectId,
      role: 'assistant',
      content: [
        '## 待你决策',
        `任务「${task.title}」合并依赖分支时发生冲突，尚未开始执行。`,
        `- ${error.message}`,
        `- 在仓库中手动合并 ${refs.join('、')} 后批准并重试，或取消任务。审批 ID：${approval.id}`,
      ].join('\n'),
    });
    if (task.status === 'queued') {
      this.transition(task.id, 'running', 'scheduler');
    }
    this.transition(task.id, 'blocked', 'scheduler');
  }

  private createGate(task: Task, worker: Worker): ApprovalGate {
    return {
      request: async (action) => {
        if (this.hasApprovedAction(task, action.tool, action.input)) return 'approved';
        const approval = this.requestApproval(task, worker, action);
        for (;;) {
          const current = this.store.getApproval(approval.id);
          if (!current || current.status === 'rejected') return 'rejected';
          if (current.status === 'approved') return 'approved';
          const latest = this.store.getTask(task.id);
          if (
            !latest ||
            latest.status === 'cancelled' ||
            latest.status === 'failed' ||
            latest.status === 'blocked'
          ) {
            this.store.decideApproval(approval.id, 'rejected', 'system');
            return 'rejected';
          }
          await delay(200);
        }
      },
    };
  }

  private requestApproval(task: Task, worker: Worker, action: ActionRequest): Approval {
    const approval = this.store.insertApproval({
      taskId: task.id,
      type: `action:${action.category}`,
      requestedBy: worker.id,
      payload: { tool: action.tool, input: action.input ?? null, category: action.category },
    });
    this.emit(task.id, worker.id, 'approval.requested', {
      approvalId: approval.id,
      type: approval.type,
      tool: action.tool,
      category: action.category,
      input: action.input,
    });
    this.store.insertMessage({
      projectId: task.projectId,
      role: 'assistant',
      content: [
        '## 待你决策',
        `员工「${worker.role}」请求执行危险动作（${action.category}），已冻结等待审批。`,
        `工具：${action.tool}`,
        `动作：${describeAction(action.input)}`,
        `批准后继续执行；拒绝则任务按拒绝处理。审批 ID：${approval.id}`,
      ].join('\n'),
    });
    return approval;
  }

  private hasApprovedAction(task: Task, tool: string, input: unknown): boolean {
    const key = actionKey({ tool, input });
    return this.store
      .listApprovals(task.projectId)
      .some(
        (approval) =>
          approval.taskId === task.id &&
          approval.status === 'approved' &&
          approval.type.startsWith('action:') &&
          actionKey(
            approval.payload as unknown as { tool: string; input: unknown },
          ) === key,
      );
  }

  private async enforceTaskBudget(
    task: Task,
    worker: Worker,
    run: ActiveRun,
  ): Promise<boolean> {
    const latest = this.store.getTask(task.id);
    if (!latest || latest.status !== 'running') return false;

    const used = addCost(this.store.sumTaskCost(task.id), run.liveCost);
    const evaluation = evaluateBudget(task.contract.budget, used);
    if (evaluation.status === 'warning' && !run.warned) {
      run.warned = true;
      this.warnTaskBudget(task, evaluation.reasons.join('；'));
    }
    if (evaluation.status !== 'exceeded') return false;

    this.flushLiveCost(worker, run);
    this.emit(task.id, worker.id, 'budget.exceeded', {
      scope: 'task',
      reasons: evaluation.reasons,
      used,
      budget: task.contract.budget,
    });
    this.store.insertMessage({
      projectId: task.projectId,
      role: 'assistant',
      content: [
        '## 待你决策',
        `任务「${task.title}」触发预算硬停，已立即停止执行：`,
        ...evaluation.reasons.map((reason) => `- ${reason}`),
        '- 调整任务预算后重新生成任务单，或取消该任务。',
      ].join('\n'),
    });
    if (latest.status === 'running') this.transition(task.id, 'blocked', 'scheduler');
    this.store.updateWorker(worker.id, { status: 'terminated', cost: run.liveCost });
    this.emit(task.id, worker.id, 'worker.status', { status: 'terminated' });
    return true;
  }

  private flushLiveCost(worker: Worker, run: ActiveRun): void {
    if (run.liveCost.usd > 0 || run.liveCost.tokensIn > 0 || run.liveCost.tokensOut > 0) {
      this.store.insertModelCall({
        workerId: worker.id,
        model: worker.model,
        cost: run.liveCost,
      });
    }
    this.store.updateWorker(worker.id, { cost: run.liveCost });
  }

  private warnTaskBudget(task: Task, reason: string): void {
    if (this.taskWarned.has(task.id)) return;
    this.taskWarned.add(task.id);
    this.emit(task.id, null, 'budget.warning', {
      scope: 'task',
      reason,
      budget: task.contract.budget,
    });
  }

  private liveProjectCost(projectId: string): number {
    let usd = 0;
    for (const run of this.active.values()) {
      const task = this.store.getTask(run.taskId);
      if (task?.projectId === projectId) usd += run.liveCost.usd;
    }
    return usd;
  }

  private async abortProjectRuns(
    project: Project,
    dailyCost: number,
    notify: boolean,
  ): Promise<void> {
    const runs = [...this.active.values()].filter(
      (run) => this.store.getTask(run.taskId)?.projectId === project.id,
    );
    if (notify) {
      this.emit(null, null, 'budget.exceeded', {
        projectId: project.id,
        scope: 'daily',
        used: dailyCost,
        limit: project.dailyBudgetUsd,
      });
    }
    for (const run of runs) {
      const task = this.store.getTask(run.taskId);
      if (!task) continue;
      run.cancelled = true;
      await run.adapter.cancel(run.session).catch(() => undefined);
      const worker = this.store.getWorker(run.workerId);
      if (worker) this.flushLiveCost(worker, run);
      this.store.updateWorker(run.workerId, { status: 'terminated' });
      this.emit(task.id, run.workerId, 'budget.exceeded', {
        scope: 'daily',
        used: dailyCost,
        limit: project.dailyBudgetUsd,
      });
      if (task.status === 'running') this.transition(task.id, 'blocked', 'scheduler');
      this.store.insertMessage({
        projectId: project.id,
        role: 'assistant',
        content: [
          '## 待你决策',
          `项目「${project.name}」触发日预算硬停：今日已用 $${dailyCost.toFixed(2)} / 上限 $${project.dailyBudgetUsd.toFixed(2)}。`,
          `任务「${task.title}」已立即停止执行。`,
          '- 提高日预算后重新生成任务单，或等预算窗口重置。',
        ].join('\n'),
      });
    }
  }

  private async finish(task: Task, worker: Worker, result: WorkerResult): Promise<void> {
    this.store.insertModelCall({ workerId: worker.id, model: worker.model, cost: result.cost });
    this.store.updateWorker(worker.id, { status: 'done', cost: result.cost });

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

    const project = this.store.getProject(task.projectId);
    const verification = await this.verification.verify({
      taskId: task.id,
      worktree: worker.worktreePath,
      criteria: task.contract.acceptance_criteria,
      artifacts: result.artifacts,
      baseRef: project?.defaultBranch,
    });
    this.store.insertEvidence(verification.evidence);
    this.store.upsertAcceptance(verification.records);

    this.emit(task.id, worker.id, 'acceptance.verified', {
      records: verification.records.map((record) => ({
        criterionId: record.criterionId,
        verdict: record.verdict,
        judgedBy: record.judgedBy,
        note: record.note,
      })),
      evidence: verification.evidence.length,
      /** 员工自报只作审计参考，不参与判定。 */
      reported: result.acceptance,
    });
    this.emit(task.id, worker.id, 'worker.finished', {
      summary: result.summary,
      cost: result.cost,
      artifacts: result.artifacts.length,
    });

    const failed = verification.records.some((record) => record.verdict === 'failed');
    const unverified = verification.records.some((record) => record.verdict === 'unverified');
    const current = this.store.getTask(task.id);
    if (!current || current.status !== 'running') return;

    // 复核全部通过才算完成；有待判定项（rubric/human 或 diff 无法复算）则交给人。
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
    this.store.insertMessage({
      projectId: task.projectId,
      role: 'assistant',
      content: [
        '## 待你决策',
        `任务「${task.title}」未派发：预算已用尽。`,
        `- ${reason}`,
        '- 调整任务预算后重新生成任务单，或取消该任务。',
      ].join('\n'),
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

  private isReadOnly(task: Task): boolean {
    const role = task.contract.assignee?.role;
    return role ? this.employees.get(role)?.readOnly ?? false : false;
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

function roleTemplate(employee: EmployeeDefinition): RoleTemplate {
  return {
    name: employee.role,
    allowedTools: employee.tools,
    readOnly: employee.readOnly,
    outputSchema: employee.outputSchema,
  };
}

function modelConfig(runtime: string, model: string): ModelConfig {
  return {
    provider: runtime,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeAction(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 200);
  if (typeof input !== 'object' || input === null) return String(input ?? '');
  const record = input as Record<string, unknown>;
  const text = record.command ?? record.cmd ?? record.script ?? record.path ?? record.url;
  return typeof text === 'string' ? text.slice(0, 200) : JSON.stringify(input).slice(0, 200);
}
