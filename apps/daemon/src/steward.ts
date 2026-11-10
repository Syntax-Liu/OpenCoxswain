import { createHash } from 'node:crypto';
import {
  assertTransition,
  buildSummary,
  computeStage,
  dependenciesOf,
  isTerminal,
  issueMandate,
  projectCapabilities,
  type TransitionActor,
} from '@opencoxswain/core';
import {
  newId,
  now,
  type AcceptanceCriterion,
  type AcceptanceDecision,
  type AcceptanceRecord,
  type AcceptanceResult,
  type Approval,
  type ArtifactRef,
  type Assistant,
  type CostLedger,
  type CreatePlanRequest,
  type CreateProjectRequest,
  type DecisionBrief,
  type DeliveryMergeResult,
  type DeliveryPlan,
  type DiffFile,
  type DiffReview,
  type Evidence,
  type MemoryKind,
  type Project,
  type ReviewLatency,
  type RoleName,
  type Task,
  type TaskContract,
  type TaskInput,
  type TaskMandate,
  type TaskReplay,
  type TaskStageView,
  type WorkbenchSnapshot,
} from '@opencoxswain/shared';
import type {
  EmployeeRegistry,
  EventService,
  MemoryService,
  PlannerService,
  RuntimeRegistry,
  SchedulerService,
  StewardService,
  StorageService,
  WorktreeService,
} from '@opencoxswain/plugin-api';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import { parseDiffPatch } from './diff-review.js';
import { inspectRepo } from './git.js';

const MANDATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface StewardOptions {
  store: StorageService;
  bus: EventService;
  planner: PlannerService;
  runtimes: RuntimeRegistry;
  scheduler: SchedulerService;
  employees: EmployeeRegistry;
  memory: MemoryService;
  worktrees: WorktreeService;
}

export class Steward implements StewardService {
  private readonly store: StorageService;
  private readonly bus: EventService;
  private readonly planner: PlannerService;
  private readonly runtimes: RuntimeRegistry;
  private readonly scheduler: SchedulerService;
  private readonly employees: EmployeeRegistry;
  private readonly memory: MemoryService;
  private readonly worktrees: WorktreeService;
  private readonly announced = new Set<string>();

  constructor(options: StewardOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.planner = options.planner;
    this.runtimes = options.runtimes;
    this.scheduler = options.scheduler;
    this.employees = options.employees;
    this.memory = options.memory;
    this.worktrees = options.worktrees;
  }

  async snapshot(projectId?: string | null): Promise<WorkbenchSnapshot> {
    const projects = this.store.listProjects();
    const project =
      (projectId ? this.store.getProject(projectId) : null) ?? projects[0] ?? null;
    const assistant = this.store.ensureAssistant();
    const runtime = await this.runtimes.health();
    const planner = await this.planner.status();

    if (!project) {
      return {
        projects,
        project: null,
        assistant,
        tasks: [],
        edges: [],
        workers: [],
        events: [],
        approvals: [],
        messages: [],
        artifacts: [],
        employees: this.employees.list(),
        acceptance: [],
        evidence: [],
        stages: [],
        inputs: [],
        summary: null,
        runtime,
        planner,
        memory: this.memory.stats(null),
        briefs: [],
        review: emptyReviewLatency(),
      };
    }

    const root = this.activeRoot(project.id);
    const tasks = this.store.listTasks(project.id);
    const inputs = this.store.listProjectInputs(project.id);
    const briefs = tasks
      .filter((task) => ['awaiting_review', 'done', 'failed'].includes(task.status))
      .map((task) => this.briefOf(task));
    return {
      projects,
      project,
      assistant,
      tasks,
      edges: this.store.listEdges(project.id),
      workers: this.store.listWorkers(project.id),
      events: this.store.listRecentEvents(project.id, 200),
      approvals: this.store.listApprovals(project.id),
      messages: this.store.listMessages(project.id),
      artifacts: this.store.listArtifacts(project.id),
      employees: this.employees.list(),
      acceptance: this.store.listProjectAcceptance(project.id),
      evidence: this.store.listProjectEvidence(project.id),
      stages: this.stages(project.id, tasks, inputs),
      inputs,
      summary: root ? this.summary(root.id) : null,
      runtime,
      planner,
      memory: this.memory.stats(project.id),
      briefs,
      review: this.store.reviewLatency(project.id),
    };
  }

  /** 「在等谁」：依赖未完成 → idle；有等待人的中途输入 → 等人回答；不改状态机。 */
  private stages(
    projectId: string,
    tasks: Task[],
    inputs: TaskInput[],
  ): TaskStageView[] {
    const edges = this.store.listEdges(projectId);
    const awaitingAnswer = new Set(
      inputs
        .filter((input) => input.source === 'human' && input.state === 'pending')
        .map((input) => input.taskId),
    );
    return tasks.map((task) => {
      const dependencyPending = dependenciesOf(task.id, edges).some((dependencyId) => {
        const dependency = this.store.getTask(dependencyId);
        return dependency ? !isTerminal(dependency.status) : false;
      });
      return {
        taskId: task.id,
        stage: computeStage({
          status: task.status,
          dependencyPending,
          hasPendingHumanInput: awaitingAnswer.has(task.id),
        }),
      };
    });
  }

  activeRoot(projectId: string): Task | null {
    const roots = this.store.listRootTasks(projectId);
    const active = roots.find((root) => !isTerminal(root.status) && root.status !== 'failed');
    return active ?? roots.at(-1) ?? null;
  }

  async createProject(request: CreateProjectRequest): Promise<Project> {
    if (!request.path?.trim()) throw new AppError('请提供本地 git 仓库路径');
    const repo = await inspectRepo(request.path.trim());
    const existing = this.store.listProjects().find((project) => project.path === repo.root);
    if (existing) {
      throw new AppError(`该项目已接入：${existing.name}`, 409);
    }
    const dailyBudgetUsd =
      typeof request.dailyBudgetUsd === 'number' && request.dailyBudgetUsd > 0
        ? request.dailyBudgetUsd
        : 10;
    const maxConcurrency =
      typeof request.maxConcurrency === 'number' &&
      request.maxConcurrency >= 1 &&
      request.maxConcurrency <= 8
        ? Math.floor(request.maxConcurrency)
        : 2;
    const project = this.store.createProject({
      name: request.name?.trim() || path.basename(repo.root),
      path: repo.root,
      defaultBranch: repo.branch,
      dailyBudgetUsd,
      maxConcurrency,
      allowNetwork: request.allowNetwork ?? true,
      allowExternalSend: request.allowExternalSend ?? false,
    });
    const stack = detectStack(repo.root);
    if (stack) {
      this.memory.remember({
        kind: 'project',
        key: 'stack',
        text: `项目「${project.name}」技术栈：${stack}`,
        source: `scan:${repo.root}`,
        projectId: project.id,
      });
    }
    this.announce(
      project.id,
      [
        `已接入项目「${project.name}」，主分支 ${project.defaultBranch}。`,
        `授权边界：工作目录 ${project.path}；${project.allowNetwork ? '允许联网读取' : '禁止联网'}；${project.allowExternalSend ? '允许外发（仍需逐次审批）' : '禁止外发'}。`,
        '告诉我你想完成什么，我先给你任务单。',
      ].join('\n'),
    );
    return project;
  }

  async createPlan(projectId: string, request: CreatePlanRequest): Promise<{ root: Task; children: Task[] }> {
    const project = this.requireProject(projectId);
    if (!request.goal?.trim()) throw new AppError('请先描述目标');

    const roots = this.store.listRootTasks(project.id);
    const draftRoots = roots.filter(
      (root) => !isTerminal(root.status) && (root.status === 'planning' || root.status === 'awaiting_approval'),
    );
    for (const root of draftRoots) {
      await this.cancelTree(root.id, 'user');
    }
    const blocking = roots.find(
      (root) => !isTerminal(root.status) && root.status !== 'failed' && root.status !== 'planning' && root.status !== 'awaiting_approval',
    );
    if (blocking) {
      throw new AppError('已有进行中的任务，请先完成或取消', 409);
    }

    const plan = await this.planner.plan(project, request);
    const createdAt = now();

    const root: Task = {
      id: plan.root.task_id,
      projectId: project.id,
      parentId: null,
      title: plan.root.title,
      goal: plan.root.goal,
      status: 'awaiting_approval',
      assigneeId: null,
      contract: plan.root,
      createdAt,
      updatedAt: createdAt,
    };
    const children: Task[] = plan.children.map((contract) => ({
      id: contract.task_id,
      projectId: project.id,
      parentId: root.id,
      title: contract.title,
      goal: contract.goal,
      status: 'draft',
      assigneeId: null,
      contract,
      createdAt: createdAt + 1,
      updatedAt: createdAt + 1,
    }));

    this.store.transaction(() => {
      this.store.insertTask(root);
      for (const child of children) this.store.insertTask(child);
      for (const edge of plan.edges) {
        this.store.insertEdge(edge.fromTaskId, edge.toTaskId);
      }
    });

    this.store.insertMessage({
      projectId: project.id,
      role: 'user',
      content: request.goal.trim(),
    });
    for (const task of [root, ...children]) {
      const event = this.store.appendEvent({
        taskId: task.id,
        type: 'task.created',
        payload: { title: task.title, status: task.status, role: task.contract.assignee?.role ?? null },
      });
      this.bus.publish(event);
    }
    const planEvent = this.store.appendEvent({
      taskId: root.id,
      type: 'task.plan_ready',
      payload: { subtasks: children.map((child) => ({ id: child.id, title: child.title })) },
    });
    this.bus.publish(planEvent);

    const references = this.memory.recall(plan.root.goal, {
      projectId: project.id,
      limit: 5,
    });
    if (references.length > 0) {
      this.bus.publish(
        this.store.appendEvent({
          taskId: root.id,
          type: 'memory.used',
          payload: {
            items: references.map((match) => ({
              id: match.entry.id,
              kind: match.entry.kind,
              reason: match.reason,
            })),
          },
        }),
      );
    }
    const budget = plan.root.budget;
    const budgetText = [
      budget.usd !== undefined ? `$${budget.usd.toFixed(2)}` : null,
      budget.tokens !== undefined ? `${budget.tokens} tokens` : null,
      budget.minutes !== undefined ? `${budget.minutes} 分钟` : null,
    ]
      .filter(Boolean)
      .join(' / ');
    this.announce(
      project.id,
      [
        '任务单已生成，等你确认开工。',
        `目标：${plan.root.goal}`,
        '子任务：',
        ...children.map((child, index) => `${index + 1}. [${child.contract.assignee?.role}] ${child.title}`),
        `预算：${budgetText}`,
        '## 我参考了这些记忆',
        ...(references.length > 0
          ? references.map(
              (match) =>
                `- [${MEMORY_KIND_LABELS[match.entry.kind]}] ${match.entry.text}（来源：${match.entry.source}）`,
            )
          : ['本次没有命中相关记忆。']),
        '确认后我会派发员工，开工前不会写你的仓库。',
      ].join('\n'),
      root.id,
    );

    return { root, children };
  }

  approveTask(taskId: string): Task {
    const root = this.requireTask(taskId);
    if (root.parentId !== null || root.status !== 'awaiting_approval') {
      throw new AppError('该任务当前不在待审批状态');
    }
    this.transition(root.id, 'queued', 'user');
    this.transition(root.id, 'running', 'scheduler');

    const children = this.store.listChildren(root.id);
    for (const child of children) {
      if (child.status !== 'draft') continue;
      const planning = this.transition(child.id, 'planning', 'scheduler');
      this.transition(planning.id, 'awaiting_approval', 'scheduler');
      this.transition(child.id, 'queued', 'user');
      this.issueMandateFor(child, 'approval');
    }

    this.announce(root.projectId, '已开工。实施员和校验员会按依赖顺序执行，有结果我第一时间汇报。', root.id);
    return this.requireTask(root.id);
  }

  rejectTask(taskId: string, note?: string): Task {
    const root = this.requireTask(taskId);
    if (root.parentId !== null || root.status !== 'awaiting_approval') {
      throw new AppError('该任务当前不在待审批状态');
    }
    this.transition(root.id, 'planning', 'user');
    for (const child of this.store.listChildren(root.id)) {
      if (!isTerminal(child.status)) this.transition(child.id, 'cancelled', 'user');
    }
    if (note?.trim()) {
      this.memory.remember({
        kind: 'lesson',
        text: `用户打回了任务「${root.title}」：${note.trim()}`,
        source: `reject:${root.id}`,
        projectId: root.projectId,
      });
    }
    this.announce(
      root.projectId,
      note?.trim() ? `已打回：${note.trim()}。请修改目标后重新生成任务单。` : '已打回。请修改目标后重新生成任务单。',
      root.id,
    );
    return this.requireTask(root.id);
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    await this.cancelTree(task.id, 'user');
    this.announce(task.projectId, `任务「${task.title}」已取消。`, task.id);
    return this.requireTask(task.id);
  }

  async pauseTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.status !== 'running' && task.status !== 'queued') {
      throw new AppError('只有排队中或执行中的任务可以暂停');
    }
    await this.scheduler.pause(task.id);
    return this.transition(task.id, 'paused', 'user');
  }

  async resumeTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.status !== 'paused') throw new AppError('任务不在暂停状态');
    const previous = this.store.getWorkerByTask(task.id) ? 'running' : 'queued';
    await this.scheduler.resume(task.id);
    return this.transition(task.id, previous, 'user');
  }

  retryTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new AppError('只有失败或阻塞的任务可以重试');
    }
    this.requeue(task, `任务「${task.title}」已重新排队执行。`);
    return this.requireTask(task.id);
  }

  /** 任务树重派：只清空当前 worktree 并重新排队，不做文件级快照回滚。 */
  async reassignTask(taskId: string, role: RoleName, note?: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.parentId === null) throw new AppError('根任务不可重派，请重新生成任务单');
    if (!['failed', 'blocked'].includes(task.status)) {
      throw new AppError('只有失败或阻塞的子任务可以重派');
    }
    if (!this.employees.get(role)) throw new AppError(`员工 ${role} 未安装`, 404);
    const current = task.contract.assignee;
    if (!current) throw new AppError('任务缺少执行者信息，无法重派');
    const fromRole = current.role;
    const contract: TaskContract = {
      ...task.contract,
      assignee: { ...current, role },
      delegated_by: 'user',
    };
    this.store.updateTaskContract(task.id, contract);
    const event = this.store.appendEvent({
      taskId: task.id,
      type: 'task.reassigned',
      payload: { fromRole, toRole: role, note: note?.trim() || null },
    });
    this.bus.publish(event);
    this.requeue({ ...task, contract }, `任务「${task.title}」已重派给「${role}」。`, fromRole !== role);
    return this.requireTask(task.id);
  }

  private requeue(task: Task, message: string, forceMandate = false): void {
    if (task.status === 'blocked') this.transition(task.id, 'failed', 'scheduler');
    if (this.store.getTask(task.id)?.status === 'failed') {
      this.transition(task.id, 'queued', 'user');
    }
    this.issueMandateFor(task, 'user', forceMandate);
    this.announce(task.projectId, message, task.id);
  }

  /** 派发前签发授权；已有未过期凭证时不重复签发。 */
  private issueMandateFor(
    task: Task,
    issuedBy: TaskMandate['issuedBy'],
    force = false,
  ): void {
    if (task.parentId === null) return;
    const role = task.contract.assignee?.role;
    if (!role) return;
    const project = this.store.getProject(task.projectId);
    if (!project) return;
    const existing = this.store.getLatestMandate(task.id);
    if (!force && issuedBy === 'user' && existing && existing.expiresAt > now()) return;
    const employee = this.employees.get(role);
    const granted = projectCapabilities(project);
    const capabilities = (employee?.capabilities ?? []).filter((capability) =>
      granted.includes(capability),
    );
    const mandate = issueMandate(task, {
      id: newId('mnd'),
      issuedBy,
      capabilities,
      root: project.path,
      roles: [role],
      ttlMs: MANDATE_TTL_MS,
    });
    this.store.insertMandate(mandate);
    const event = this.store.appendEvent({
      taskId: task.id,
      type: 'mandate.issued',
      payload: {
        mandateId: mandate.id,
        issuedBy,
        expiresAt: mandate.expiresAt,
        capabilities: mandate.capabilities,
        root: mandate.root,
        roles: mandate.roles,
      },
    });
    this.bus.publish(event);
  }

  /**
   * 逐条验收：每条未通过的验收项都必须带结论与理由，不接受“一键全部通过”。
   * 子任务完成即可单独验收；根任务仍由人做最终收口，子任务验收不会顺带放行根任务。
   * 系统已复核的证据不会被覆盖；人的结论作为新的判定记录留档。
   */
  decideAcceptance(
    taskId: string,
    decisions: AcceptanceDecision[],
    judgedByUser = '本机用户',
  ): Task {
    const target = this.requireTask(taskId);
    if (target.status !== 'awaiting_review') {
      throw new AppError('该任务当前不在待验收状态');
    }
    const brief = this.briefOf(target);
    const missingBrief = (['changed', 'why', 'verified', 'risks'] as const).filter(
      (field) => !brief[field].trim(),
    );
    if (missingBrief.length > 0) {
      throw new AppError(`决策说明缺少字段：${missingBrief.join('、')}，不能提交验收`, 409);
    }
    const provided = new Map<string, AcceptanceDecision>();
    for (const decision of decisions) {
      const key = decision.criterionId.trim();
      if (!key) throw new AppError('criterionId 不能为空');
      const note = decision.note?.trim();
      if (!note) throw new AppError(`验收项 ${key} 必须填写判断理由`, 400);
      if (decision.verdict !== 'passed' && decision.verdict !== 'failed') {
        throw new AppError(`验收项 ${key} 的结论只能是 passed 或 failed`, 400);
      }
      if (provided.has(key)) throw new AppError(`验收项 ${key} 重复提交`, 400);
      provided.set(key, { ...decision, note });
    }

    const missing: string[] = [];
    const records: AcceptanceRecord[] = [];
    const evidence: Evidence[] = [];
    const at = now();
    const existing = new Map(
      this.store.listTaskAcceptance(target.id).map((record) => [record.criterionId, record]),
    );

    for (const criterion of target.contract.acceptance_criteria) {
      const key = criterion.id;
      const current = existing.get(key);
      if (current?.verdict === 'passed') continue;
      const decision = provided.get(key);
      if (!decision) {
        missing.push(`${target.id}:${key}`);
        continue;
      }
      const note = decision.note;
      const item: Evidence = {
        id: newId('ev'),
        taskId: target.id,
        criterionId: criterion.id,
        kind: 'human_note',
        ref: note,
        digest: `human:${note}`,
        producedBy: 'human',
        createdAt: at,
      };
      evidence.push(item);
      records.push({
        taskId: target.id,
        criterionId: criterion.id,
        verdict: decision.verdict,
        evidenceIds: [item.id],
        judgedBy: 'human',
        judgedByUser,
        note,
        at,
      });
    }

    if (missing.length > 0) {
      throw new AppError(`以下验收项还没有结论：${missing.join('、')}`, 409);
    }

    this.store.insertEvidence(evidence);
    this.store.upsertAcceptance(records);
    this.store.markTaskDecided(target.id);
    const event = this.store.appendEvent({
      taskId: target.id,
      type: 'acceptance.decided',
      payload: {
        records: records.map((record) => ({
          taskId: record.taskId,
          criterionId: record.criterionId,
          verdict: record.verdict,
        })),
        judgedByUser,
      },
    });
    this.bus.publish(event);
    if (records.length > 0) {
      this.bus.publish(
        this.store.appendEvent({
          taskId: target.id,
          type: 'acceptance.human_touch',
          payload: { decisions: records.length, judgedByUser },
        }),
      );
    }

    const isRoot = target.parentId === null;
    const ownRecords = this.store.listTaskAcceptance(target.id);
    const verdicts = target.contract.acceptance_criteria.map(
      (criterion) => ownRecords.find((record) => record.criterionId === criterion.id)?.verdict,
    );
    if (isRoot) {
      // 根任务收口：自身判定全过且子任务全部完成才算 done；任一失败即失败。
      const children = this.store.listChildren(target.id);
      if (verdicts.some((verdict) => verdict === 'failed')) {
        this.transition(target.id, 'failed', 'user');
      } else if (children.some((child) => child.status === 'failed')) {
        this.transition(target.id, 'failed', 'user');
      } else if (
        verdicts.every((verdict) => verdict === 'passed') &&
        children.every((child) => child.status === 'done')
      ) {
        this.transition(target.id, 'done', 'user');
      }
    } else if (verdicts.some((verdict) => verdict === 'failed')) {
      this.transition(target.id, 'failed', 'user');
    } else if (verdicts.every((verdict) => verdict === 'passed')) {
      this.transition(target.id, 'done', 'user');
    }

    const settled = this.requireTask(target.id);
    if (!isRoot) return settled;

    if (settled.status === 'failed') {
      const tree = [settled, ...this.store.listChildren(settled.id)];
      const reasons = tree
        .flatMap((task) => this.store.listTaskAcceptance(task.id))
        .filter((record) => record.verdict === 'failed' && record.note?.trim())
        .map((record) => record.note!.trim());
      this.memory.remember({
        kind: 'lesson',
        text: `任务「${settled.title}」验收未通过${reasons.length > 0 ? `：${reasons.join('；')}` : '，需要人工排查原因'}`,
        source: `acceptance:${settled.id}`,
        projectId: settled.projectId,
      });
      this.announce(
        settled.projectId,
        `## 待你决策\n\n任务「${settled.title}」验收未通过，已停在 failed。\n- 可修正后重试，或取消任务。`,
        settled.id,
      );
      return settled;
    }

    if (settled.status !== 'done') {
      // 根任务还需要等子任务完成验收，先不产出最终汇总。
      return settled;
    }

    this.memory.remember({
      kind: 'decision',
      text: `任务「${settled.title}」已通过验收：${settled.goal}`,
      source: `acceptance:${settled.id}`,
      projectId: settled.projectId,
    });

    const summary = this.summary(settled.id);
    this.announce(settled.projectId, summary, settled.id);
    return this.requireTask(settled.id);
  }

  /** 人打开验收单时记一次，供反馈延迟统计使用。 */
  markViewed(taskId: string): Task {
    const task = this.requireTask(taskId);
    this.store.markTaskViewed(task.id);
    return this.requireTask(task.id);
  }

  /**
   * 验收决策说明：四段由任务契约与系统复核结果生成，员工自述不参与。
   * 每次生成都会覆盖落库，保证“验过什么”与最新证据一致。
   */
  brief(taskId: string): DecisionBrief {
    return this.briefOf(this.requireTask(taskId));
  }

  /** 交付说明 + 合并计划；四段说明直接复用决策说明，避免两套叙述。 */
  async delivery(taskId: string): Promise<DeliveryPlan> {
    const task = this.requireTask(taskId);
    if (task.parentId !== null) {
      throw new AppError('只有根任务有交付计划', 409);
    }
    const project = this.requireProject(task.projectId);
    const brief = this.briefOf(task);
    const children = this.store.listChildren(task.id);
    const subtree = [task, ...children];
    const blocked: string[] = [];

    if (task.status !== 'done') {
      blocked.push(`任务状态是 ${task.status}，完成最终验收后才能合并`);
    }
    const unfinished = children.filter((child) => child.status !== 'done');
    if (unfinished.length > 0) {
      blocked.push(`还有 ${unfinished.length} 个子任务未完成：${unfinished
        .map((child) => child.title)
        .slice(0, 3)
        .join('、')}${unfinished.length > 3 ? ' 等' : ''}`);
    }
    if (children.length === 0) {
      blocked.push('没有子任务产物，没有可合并的分支');
    }

    const branches: string[] = [];
    for (const child of children) {
      if (child.status !== 'done') continue;
      const worker = this.store.getWorkerByTask(child.id);
      if (!worker?.branch) {
        blocked.push(`子任务「${child.title}」没有可交付分支`);
        continue;
      }
      if (!branches.includes(worker.branch)) branches.push(worker.branch);
    }
    if (branches.length === 0) blocked.push('没有可合并的分支');

    const pendingApprovals = this.store
      .listApprovals(project.id)
      .filter(
        (approval) =>
          approval.status === 'pending' && subtree.some((item) => item.id === approval.taskId),
      );
    if (pendingApprovals.length > 0) {
      blocked.push(`还有 ${pendingApprovals.length} 个审批未处理`);
    }
    if (this.store.listTaskSideEffects(task.id).some((effect) => effect.kind === 'net.send')) {
      blocked.push('存在外发动作，不能自动合并');
    }

    let state = {
      branch: '',
      head: '',
      clean: false,
      diffs: [] as Array<{
        ref: string;
        files: number;
        additions: number;
        deletions: number;
        paths: string[];
      }>,
    };
    if (branches.length > 0) {
      try {
        state = await this.worktrees.inspect(project, branches);
      } catch (error) {
        blocked.push(
          `检查仓库失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (state.branch && state.branch !== project.defaultBranch) {
      blocked.push(`当前分支是 ${state.branch}，请切回 ${project.defaultBranch}`);
    }
    if (state.branch && !state.clean) {
      blocked.push('工作区有未提交改动，请先提交或清理');
    }

    const changedFiles = [...new Set(state.diffs.flatMap((diff) => diff.paths))];
    const additions = state.diffs.reduce((total, diff) => total + diff.additions, 0);
    const deletions = state.diffs.reduce((total, diff) => total + diff.deletions, 0);

    const riskReasons: string[] = [];
    const profiles = new Set(
      subtree.map((item) => item.contract.deliverable_profile ?? 'code'),
    );
    if (!(profiles.size === 1 && profiles.has('document'))) {
      riskReasons.push('交付物不全是文档类型');
    }
    if (deletions > 0) riskReasons.push(`包含删除（${deletions} 行）`);
    const riskyEffects = subtree.flatMap((item) => this.store.listTaskSideEffects(item.id));
    if (riskyEffects.some((effect) => effect.kind === 'fs.delete')) {
      riskReasons.push('存在删除文件的副作用');
    }
    if (riskyEffects.some((effect) => effect.kind === 'net.send')) {
      riskReasons.push('存在外发副作用');
    }
    if (pendingApprovals.some((approval) => approval.type === 'merge_conflict')) {
      riskReasons.push('有未解决的合并冲突');
    }
    const risk = riskReasons.length === 0 ? 'low' : 'high';
    if (risk === 'high') {
      blocked.push(`高风险交付不提供一键合并：${riskReasons.join('；')}`);
    }

    const planHash = createHash('sha256')
      .update(
        JSON.stringify({
          taskId: task.id,
          baseBranch: project.defaultBranch,
          baseHead: state.head,
          branches,
          changedFiles,
          additions,
          deletions,
          risk,
        }),
      )
      .digest('hex')
      .slice(0, 16);

    return {
      taskId: task.id,
      brief,
      baseBranch: project.defaultBranch,
      baseHead: state.head,
      branches,
      changedFiles,
      additions,
      deletions,
      risk,
      riskReasons,
      mergeable: blocked.length === 0,
      blockedReasons: blocked,
      rollback: `git reset --hard ${state.head || '<合并前提交>'}`,
      planHash,
      generatedAt: now(),
    };
  }

  async mergeDelivery(
    taskId: string,
    request: { confirm: boolean; planHash: string },
  ): Promise<{ plan: DeliveryPlan; result: DeliveryMergeResult }> {
    if (!request.confirm) throw new AppError('请先确认合并计划', 400);
    const plan = await this.delivery(taskId);
    if (plan.planHash !== request.planHash) {
      throw new AppError('交付内容已变化，请重新预览后再确认', 409);
    }
    if (!plan.mergeable) {
      throw new AppError(plan.blockedReasons.join('；') || '当前不满足合并条件', 409);
    }
    const task = this.requireTask(taskId);
    const project = this.requireProject(task.projectId);
    try {
      const merged = await this.worktrees.merge(project, plan.branches);
      this.bus.publish(
        this.store.appendEvent({
          taskId: task.id,
          type: 'delivery.merged',
          payload: {
            baseBranch: merged.baseBranch,
            head: merged.head,
            branches: merged.branches,
            risk: plan.risk,
          },
        }),
      );
      return {
        plan,
        result: {
          baseBranch: merged.baseBranch,
          head: merged.head,
          branches: merged.branches,
          mergedAt: now(),
        },
      };
    } catch (error) {
      throw new AppError(
        `合并失败，已回滚到 ${plan.rollback}：${
          error instanceof Error ? error.message : String(error)
        }`,
        409,
      );
    }
  }

  /**
   * 逐文件 diff：根任务汇总子任务产物，单个任务只看自己。
   * 同一路径在多个分支出现时合并计数并明确提示，避免看起来像漏了文件。
   */
  diffReview(taskId: string): DiffReview {
    const task = this.requireTask(taskId);
    const scope =
      task.parentId === null ? [task, ...this.store.listChildren(task.id)] : [task];
    const artifacts = scope
      .flatMap((item) => this.store.listTaskArtifacts(item.id))
      .filter((artifact) => artifact.type === 'diff');

    const byPath = new Map<string, DiffFile>();
    const notes: string[] = [];
    let omitted = 0;
    for (const artifact of artifacts) {
      let patch: string;
      try {
        patch = readFileSync(artifact.path, 'utf8');
      } catch (error) {
        notes.push(
          `产物 ${artifact.path} 读取失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const parsed = parseDiffPatch(patch);
      omitted += parsed.omitted;
      for (const file of parsed.files) {
        const existing = byPath.get(file.path);
        if (!existing) {
          byPath.set(file.path, { ...file });
          continue;
        }
        existing.additions += file.additions;
        existing.deletions += file.deletions;
        existing.hunks = [existing.hunks, file.hunks].filter(Boolean).join('\n');
        existing.binary ||= file.binary;
        existing.truncated ||= file.truncated;
        if (existing.status !== file.status) existing.status = 'modified';
        const merged = [existing.notice, file.notice].filter(Boolean).join('；');
        existing.notice = merged || undefined;
        if (!notes.includes('同一文件在多个分支中被修改，已合并展示')) {
          notes.push('同一文件在多个分支中被修改，已合并展示');
        }
      }
    }

    const files = [...byPath.values()];
    return {
      taskId: task.id,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      binary: files.filter((file) => file.binary).length,
      truncated: files.filter((file) => file.truncated).length,
      omitted,
      artifactPaths: artifacts.map((artifact) => artifact.path),
      notes,
      generatedAt: now(),
    };
  }

  private briefOf(task: Task): DecisionBrief {
    const artifacts = this.store.listTaskArtifacts(task.id);
    const records = this.store.listTaskAcceptance(task.id);
    const criteria = task.contract.acceptance_criteria;
    const judged = criteria
      .map((criterion) => ({
        criterion,
        verdict: records.find((record) => record.criterionId === criterion.id)?.verdict,
      }))
      .filter((item) => item.verdict !== undefined);
    const passed = judged.filter((item) => item.verdict === 'passed').length;
    const failed = judged.filter((item) => item.verdict === 'failed').length;
    const pending = criteria.filter(
      (criterion) => !records.some((record) => record.criterionId === criterion.id),
    );

    const changed =
      artifacts.length > 0
        ? `改动 ${artifacts.length} 项：${artifacts
            .slice(0, 6)
            .map((artifact) => artifact.path || artifact.type)
            .join('、')}${artifacts.length > 6 ? ' 等' : ''}`
        : '没有文件改动，仅有过程汇报。';

    const verifiedParts: string[] = [];
    if (passed > 0) verifiedParts.push(`系统复核通过 ${passed} 项`);
    if (failed > 0) verifiedParts.push(`失败 ${failed} 项`);
    if (pending.length > 0) verifiedParts.push(`待人工判断 ${pending.length} 项`);
    const evidenceIds = records.flatMap((record) => record.evidenceIds);

    const risks: string[] = [];
    if (pending.length > 0) {
      risks.push(`${pending.length} 项验收标准还没有结论`);
    }
    const approvals = this.store.listApprovals(task.projectId).filter(
      (approval) => approval.taskId === task.id,
    );
    const conflict = approvals.find((approval) => approval.type === 'merge_conflict');
    if (conflict) {
      const detail =
        typeof conflict.payload === 'object' && conflict.payload !== null
          ? String((conflict.payload as Record<string, unknown>).detail ?? '')
          : '';
      risks.push(`合并冲突未解决${detail ? `：${detail}` : ''}`);
    }
    if (approvals.some((approval) => approval.type === 'danger' && approval.status === 'pending')) {
      risks.push('还有危险动作等待批准');
    }
    if (records.length === 0 && artifacts.length > 0) {
      risks.push('尚无系统复核记录，改动未被验证');
    }

    const brief: DecisionBrief = {
      taskId: task.id,
      changed,
      why: task.goal.trim() || task.title,
      verified:
        verifiedParts.length > 0
          ? `${verifiedParts.join('；')}（命令重跑与 diff 复算由系统执行）`
          : '尚未产生系统复核结果。',
      risks: risks.length > 0 ? risks.join('；') : '未发现已知风险。',
      evidenceRefs: evidenceIds,
      conflictReason: conflict
        ? `合并冲突：${
            typeof conflict.payload === 'object' && conflict.payload !== null
              ? String((conflict.payload as Record<string, unknown>).detail ?? conflict.id)
              : conflict.id
          }`
        : null,
      generatedAt: now(),
    };
    this.store.upsertBrief(brief);
    return brief;
  }

  summary(taskId: string): string {
    const task = this.requireTask(taskId);
    const tree = task.parentId === null ? [task, ...this.store.listChildren(task.id)] : [task];
    const ids = new Set(tree.map((item) => item.id));

    const criteria: AcceptanceCriterion[] = [];
    const results: AcceptanceResult[] = [];
    for (const item of tree) {
      for (const criterion of item.contract.acceptance_criteria) {
        criteria.push({
          ...criterion,
          id: `${item.id}/${criterion.id}`,
          desc: item.parentId === null ? criterion.desc : `【${item.title}】${criterion.desc}`,
        });
      }
      for (const record of this.store.listTaskAcceptance(item.id)) {
        results.push({
          criterionId: `${item.id}/${record.criterionId}`,
          status: record.verdict,
          judgedBy: record.judgedBy,
          evidence: record.note ?? record.evidenceIds.join(','),
        });
      }
    }

    const artifacts: ArtifactRef[] = [];
    const cost: CostLedger = { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 };
    let branch: string | undefined;
    for (const item of tree) {
      for (const artifact of this.store.listTaskArtifacts(item.id)) {
        artifacts.push({
          type: artifact.type,
          path: artifact.path,
          meta: artifact.meta,
        });
      }
      const worker = this.store.getWorkerByTask(item.id);
      if (worker) {
        branch ??= worker.branch;
        cost.tokensIn += worker.cost.tokensIn;
        cost.tokensOut += worker.cost.tokensOut;
        cost.usd += worker.cost.usd;
        cost.minutes += worker.cost.minutes;
      }
    }

    return buildSummary({
      contract: { ...task.contract, acceptance_criteria: criteria },
      status: task.status,
      acceptance: results,
      artifacts,
      cost,
      branch,
      approvals: this.store.listApprovals(task.projectId).filter((approval) => ids.has(approval.taskId)),
    });
  }

  replay(taskId: string): TaskReplay {
    const task = this.requireTask(taskId);
    const children = task.parentId === null ? this.store.listChildren(task.id) : [];
    const tree = [task, ...children];
    const ids = new Set(tree.map((item) => item.id));
    const events = tree
      .flatMap((item) => this.store.listTaskEvents(item.id))
      .sort((a, b) => a.id - b.id);
    return {
      task,
      children,
      edges: this.store.listEdges(task.projectId).filter((edge) => ids.has(edge.fromTaskId)),
      workers: this.store.listWorkers(task.projectId).filter((worker) => ids.has(worker.taskId)),
      events,
      artifacts: this.store.listArtifacts(task.projectId).filter((artifact) => ids.has(artifact.taskId)),
      approvals: this.store.listApprovals(task.projectId).filter((approval) => ids.has(approval.taskId)),
      acceptance: tree.flatMap((item) => this.store.listTaskAcceptance(item.id)),
      evidence: tree.flatMap((item) => this.store.listTaskEvidence(item.id)),
      supervision: tree.flatMap((item) => this.store.listTaskSupervision(item.id)),
      mandates: tree.flatMap((item) => this.store.listTaskMandates(item.id)),
      sideEffects: tree.flatMap((item) => this.store.listTaskSideEffects(item.id)),
      summary: this.summary(task.id),
    };
  }

  onRootSettled(rootId: string): void {
    if (this.announced.has(rootId)) return;
    this.announced.add(rootId);
    const root = this.store.getTask(rootId);
    if (!root) return;
    const summary = this.summary(rootId);
    this.announce(root.projectId, summary, root.id);
    const event = this.store.appendEvent({
      taskId: root.id,
      type: 'summary.ready',
      payload: { summary },
    });
    this.bus.publish(event);
  }

  decideApproval(id: string, status: 'approved' | 'rejected'): Approval {
    const approval = this.store.decideApproval(id, status, 'user');
    const event = this.store.appendEvent({
      taskId: approval.taskId,
      type: 'approval.decided',
      payload: { approvalId: id, status },
    });
    this.bus.publish(event);

    if (approval.type.startsWith('action:') || approval.type === 'merge_conflict') {
      const task = this.store.getTask(approval.taskId);
      if (task && status === 'approved' && (task.status === 'failed' || task.status === 'blocked')) {
        this.requeue(
          task,
          approval.type === 'merge_conflict'
            ? `已确认冲突处理，任务「${task.title}」重新排队执行。`
            : `已批准危险动作，任务「${task.title}」重新排队执行。`,
        );
      } else if (task && status === 'rejected') {
        this.announce(
          task.projectId,
          approval.type === 'merge_conflict'
            ? `已拒绝冲突处理，任务「${task.title}」不会继续执行。`
            : `已拒绝危险动作，任务「${task.title}」不会继续执行。`,
          task.id,
        );
      }
    }
    return approval;
  }

  updateAssistant(
    patch: Partial<Pick<Assistant, 'name' | 'avatar' | 'persona' | 'tone' | 'proactivity'>>,
  ): Assistant {
    return this.store.updateAssistant(patch);
  }

  updateProjectSettings(
    projectId: string,
    patch: { dailyBudgetUsd?: number; maxConcurrency?: number },
  ): Project {
    return this.store.updateProjectSettings(projectId, patch);
  }

  private async cancelTree(taskId: string, actor: TransitionActor): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    for (const child of this.store.listChildren(taskId)) {
      await this.cancelTree(child.id, actor);
    }
    const current = this.store.getTask(taskId);
    if (!current || isTerminal(current.status)) return;
    await this.scheduler.cancel(taskId);
    this.transition(taskId, 'cancelled', actor);
  }

  private transition(taskId: string, to: Task['status'], actor: TransitionActor): Task {
    const task = this.requireTask(taskId);
    assertTransition(task.status, to, actor);
    this.store.setTaskStatus(taskId, to);
    const event = this.store.appendEvent({
      taskId,
      type: 'task.status_changed',
      payload: { from: task.status, to, actor },
    });
    this.bus.publish(event);
    return this.requireTask(taskId);
  }

  private announce(projectId: string, content: string, taskId: string | null = null): void {
    this.store.insertMessage({ projectId, role: 'assistant', content });
    const event = this.store.appendEvent({
      taskId,
      type: 'message.created',
      payload: { content },
    });
    this.bus.publish(event);
  }

  private requireProject(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new AppError(`项目不存在：${id}`, 404);
    return project;
  }

  private requireTask(id: string): Task {
    const task = this.store.getTask(id);
    if (!task) throw new AppError(`任务不存在：${id}`, 404);
    return task;
  }
}

const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  profile: '偏好',
  project: '项目',
  decision: '决策',
  lesson: '教训',
};

const FRAMEWORKS: Array<[string, string]> = [
  ['react', 'React'],
  ['vue', 'Vue'],
  ['next', 'Next.js'],
  ['svelte', 'Svelte'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
];

/** 轻量识别技术栈，只读几个标记文件，不执行任何命令。 */
function detectStack(repoRoot: string): string | null {
  const read = (name: string): string | null => {
    const file = path.join(repoRoot, name);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8').slice(0, 8192);
    } catch {
      return null;
    }
  };
  const found: string[] = [];
  const pkgRaw = read('package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        packageManager?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const parts = ['Node.js'];
      if (pkg.packageManager) parts.push(pkg.packageManager.split('@')[0] ?? '');
      else if (existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) parts.push('pnpm');
      if (deps.typescript) parts.push('TypeScript');
      for (const [dep, label] of FRAMEWORKS) {
        if (deps[dep]) parts.push(label);
      }
      found.push(parts.filter(Boolean).join(' / '));
    } catch {
      found.push('Node.js');
    }
  }
  if (read('Cargo.toml')) found.push('Rust');
  if (read('go.mod')) found.push('Go');
  if (read('pyproject.toml') || read('requirements.txt')) found.push('Python');
  return found.length > 0 ? found.join('；') : null;
}

function emptyReviewLatency(): ReviewLatency {
  return {
    samples: 0,
    waiting: 0,
    viewLagP50: null,
    viewLagP95: null,
    decideLagP50: null,
    decideLagP95: null,
  };
}
