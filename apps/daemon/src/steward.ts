import {
  assertTransition,
  buildSummary,
  isTerminal,
  type TransitionActor,
} from '@opencoxswain/core';
import {
  now,
  type AcceptanceCriterion,
  type AcceptanceResult,
  type Approval,
  type ArtifactRef,
  type Assistant,
  type CostLedger,
  type CreatePlanRequest,
  type CreateProjectRequest,
  type Project,
  type Task,
  type TaskReplay,
  type WorkbenchSnapshot,
} from '@opencoxswain/shared';
import type {
  EventService,
  PlannerService,
  RuntimeRegistry,
  SchedulerService,
  StewardService,
  StorageService,
} from '@opencoxswain/plugin-api';
import path from 'node:path';
import { AppError } from './errors.js';
import { inspectRepo } from './git.js';

export interface StewardOptions {
  store: StorageService;
  bus: EventService;
  planner: PlannerService;
  runtimes: RuntimeRegistry;
  scheduler: SchedulerService;
}

export class Steward implements StewardService {
  private readonly store: StorageService;
  private readonly bus: EventService;
  private readonly planner: PlannerService;
  private readonly runtimes: RuntimeRegistry;
  private readonly scheduler: SchedulerService;
  private readonly announced = new Set<string>();

  constructor(options: StewardOptions) {
    this.store = options.store;
    this.bus = options.bus;
    this.planner = options.planner;
    this.runtimes = options.runtimes;
    this.scheduler = options.scheduler;
  }

  async snapshot(projectId?: string | null): Promise<WorkbenchSnapshot> {
    const projects = this.store.listProjects();
    const project =
      (projectId ? this.store.getProject(projectId) : null) ?? projects[0] ?? null;
    const assistant = this.store.ensureAssistant();
    const runtime = await this.runtimes.health();

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
        summary: null,
        runtime,
      };
    }

    const root = this.activeRoot(project.id);
    return {
      projects,
      project,
      assistant,
      tasks: this.store.listTasks(project.id),
      edges: this.store.listEdges(project.id),
      workers: this.store.listWorkers(project.id),
      events: this.store.listRecentEvents(project.id, 200),
      approvals: this.store.listApprovals(project.id),
      messages: this.store.listMessages(project.id),
      artifacts: this.store.listArtifacts(project.id),
      summary: root ? this.summary(root.id) : null,
      runtime,
    };
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
    });
    this.announce(
      project.id,
      `已接入项目「${project.name}」，主分支 ${project.defaultBranch}。告诉我你想完成什么，我先给你任务单。`,
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

  acceptTask(taskId: string): Task {
    const root = this.requireTask(taskId);
    if (root.parentId !== null || root.status !== 'awaiting_review') {
      throw new AppError('该任务当前不在待验收状态');
    }
    const tree = [root, ...this.store.listChildren(root.id)];
    const unresolved: string[] = [];

    for (const task of tree) {
      const existing = new Map(
        this.store.listAcceptance(task.id).map((result) => [result.criterionId, result]),
      );
      for (const criterion of task.contract.acceptance_criteria) {
        const result = existing.get(criterion.id);
        if (result && result.status !== 'unverified') continue;
        if (criterion.type === 'human' || criterion.type === 'rubric') {
          this.store.setAcceptance(task.id, [
            {
              criterionId: criterion.id,
              status: 'passed',
              evidence: '用户验收通过',
              judgedBy: 'human',
            },
          ]);
        } else {
          unresolved.push(`${task.title} / ${criterion.id}`);
        }
      }
    }

    if (unresolved.length > 0) {
      throw new AppError(`还有验收项未验证，不能完成：${unresolved.join('；')}`, 409);
    }

    this.transition(root.id, 'done', 'user');
    this.announce(root.projectId, this.summary(root.id), root.id);
    return this.requireTask(root.id);
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
      for (const result of this.store.listAcceptance(item.id)) {
        results.push({ ...result, criterionId: `${item.id}/${result.criterionId}` });
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
