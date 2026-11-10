import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AcceptanceCriterion,
  AcceptanceDecision,
  AcceptanceRecord,
  AcceptanceResult,
  Approval,
  ArtifactRecord,
  ArtifactRef,
  Assistant,
  CostLedger,
  CreatePlanRequest,
  CreateProjectRequest,
  DecisionBrief,
  DeliveryMergeResult,
  DeliveryPlan,
  DiffReview,
  EmployeeDefinition,
  EventRecord,
  Evidence,
  Message,
  MemoryCandidate,
  MemoryEntry,
  MemoryMatch,
  MemoryReport,
  MemoryStats,
  MemoryWriteResult,
  PlannerStatus,
  Project,
  DeliverableProfile,
  ProjectCostReport,
  GateQuality,
  ReviewLatency,
  RoleName,
  RouteSuggestion,
  Run,
  RuntimeStatus,
  Schedule,
  ScheduleRun,
  SideEffect,
  SideEffectKind,
  SideEffectState,
  SupervisionAction,
  SupervisionVerdict,
  Task,
  TaskContract,
  TaskEdge,
  TaskInput,
  TaskMandate,
  TaskReplay,
  TaskStatus,
  TaskTemplate,
  Worker,
  WorkerResult,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import type { RuntimeAdapter } from '@opencoxswain/adapters';

export const PLUGIN_API_VERSION = 1;

export type PluginKind =
  | 'runtime'
  | 'planner'
  | 'scheduler'
  | 'steward'
  | 'storage'
  | 'transport'
  | 'api'
  | 'ui'
  | 'worktree'
  | 'employee'
  | 'other';

/** 权限清单是唯一事实来源：清单校验、内核闸门与外部插件都用这一份。 */
export const PERMISSIONS = [
  'events:publish',
  'events:read',
  'storage:read',
  'storage:write',
  'storage:provide',
  'fs:data',
  'fs:worktree',
  'process:spawn',
  'runtime:use',
  'runtime:provide',
  'planner:use',
  'scheduler:control',
  'steward:call',
  'secrets:read',
  'secrets:write',
  'secrets:provide',
  'http:route',
  'net:listen',
  'employee:use',
  'employee:provide',
  'template:use',
  'template:provide',
  'verification:run',
  'verification:provide',
  'supervisor:use',
  'supervisor:provide',
  'mandate:read',
  'mandate:issue',
  'memory:read',
  'memory:write',
  'memory:provide',
  'schedule:use',
  'schedule:provide',
  'router:use',
  'router:provide',
  'ui:panel',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface OpenCoxswainConfig {
  version: string;
  host: string;
  port: number;
  homeDir: string;
  dbPath: string;
  worktreesDir: string;
  artifactsDir: string;
  /** 记忆库目录：SQLite 数据库与导出的 Markdown 快照。 */
  memoryDir: string;
  pluginsDir: string;
  maxConcurrency: number;
  /** 任务默认运行时（mock / opencode）。 */
  defaultRuntime: string;
  /** 覆盖默认模型；空字符串表示使用运行时默认模型。 */
  defaultModel: string;
  /** OpenCode CLI 显式路径；空字符串表示自动发现。 */
  opencodeBin: string;
  /** 系统复核 command 验收的超时（毫秒）。 */
  commandTimeoutMs: number;
  /** 规则监察的检查间隔（毫秒）。 */
  supervisionIntervalMs: number;
  /** 运行租约有效期（毫秒）；超时视为孤儿。 */
  leaseTtlMs: number;
}

export interface StorageService {
  close(): void;
  transaction<T>(fn: () => T): T;
  createProject(input: {
    name: string;
    path: string;
    defaultBranch: string;
    dailyBudgetUsd: number;
    maxConcurrency: number;
    allowNetwork?: boolean;
    allowExternalSend?: boolean;
  }): Project;
  listProjects(): Project[];
  getProject(id: string): Project | null;
  updateProjectSettings(
    id: string,
    patch: { dailyBudgetUsd?: number; maxConcurrency?: number },
  ): Project;
  ensureAssistant(): Assistant;
  updateAssistant(
    patch: Partial<Pick<Assistant, 'name' | 'avatar' | 'persona' | 'tone' | 'proactivity'>>,
  ): Assistant;
  insertTask(task: Task): void;
  getTask(id: string): Task | null;
  listTasks(projectId: string): Task[];
  listChildren(parentId: string): Task[];
  listRootTasks(projectId: string): Task[];
  setTaskStatus(id: string, status: TaskStatus): void;
  setTaskAssignee(id: string, assigneeId: string | null): void;
  insertEdge(fromTaskId: string, toTaskId: string, type?: string): void;
  listEdges(projectId: string): TaskEdge[];
  insertWorker(worker: Worker): void;
  getWorker(id: string): Worker | null;
  getWorkerByTask(taskId: string): Worker | null;
  listWorkers(projectId: string): Worker[];
  updateWorker(
    id: string,
    patch: Partial<Pick<Worker, 'status' | 'sessionRef' | 'cost' | 'worktreePath' | 'branch'>>,
  ): Worker;
  insertRun(id: string, workerId: string, attempt: number): void;
  finishRun(id: string, result: WorkerResult | null, error: string | null): void;
  /** 原子认领执行租约；已被他人持有或未过期时返回 false。 */
  claimRun(runId: string, owner: string, ttlMs: number): boolean;
  /** 续约；租约已过期或 owner 不匹配时返回 false。 */
  renewLease(runId: string, owner: string, ttlMs: number): boolean;
  releaseRun(runId: string): void;
  /** 列出已过期但未结束的 run。 */
  listExpiredRuns(now: number): Array<{ taskId: string; runId: string; workerId: string }>;
  markRunOrphaned(runId: string): void;
  /** 租约未过期的重启现场：保留 running，标记结果未知。 */
  markRunRecoveredUnknown(runId: string): void;
  /** 复用孤儿 run 记录重新派发，避免重复计费。 */
  reviveRun(runId: string, workerId: string, owner: string, ttlMs: number): void;
  takeOrphanRun(taskId: string): string | null;
  getActiveRun(taskId: string): Run | null;
  listOrphanedRuns(): Run[];
  insertMandate(mandate: TaskMandate): void;
  getLatestMandate(taskId: string): TaskMandate | null;
  listTaskMandates(taskId: string): TaskMandate[];
  updateTaskContract(id: string, contract: Task['contract']): void;
  insertSideEffect(input: {
    taskId: string;
    workerId: string | null;
    runId: string | null;
    kind: SideEffectKind;
    target: string;
    idempotencyKey: string;
    reversible: boolean;
  }): SideEffect;
  getSideEffectByKey(taskId: string, idempotencyKey: string): SideEffect | null;
  updateSideEffect(
    id: string,
    patch: { state?: SideEffectState; result?: string | null },
  ): SideEffect;
  listTaskSideEffects(taskId: string): SideEffect[];
  listPendingSideEffects(): SideEffect[];
  insertInput(input: TaskInput): void;
  updateInputState(id: string, state: TaskInput['state'], deliveredAt?: number): void;
  listTaskInputs(taskId: string): TaskInput[];
  listProjectInputs(projectId: string): TaskInput[];
  insertSupervisionAction(action: SupervisionAction): void;
  listTaskSupervision(taskId: string): SupervisionAction[];
  insertEvidence(items: Evidence[]): void;
  upsertAcceptance(records: AcceptanceRecord[]): void;
  listTaskAcceptance(taskId: string): AcceptanceRecord[];
  listProjectAcceptance(projectId: string): AcceptanceRecord[];
  /** 首次打开验收单的时间；重复调用不会覆盖。 */
  markTaskViewed(id: string): void;
  /** 人提交验收结论的时间；重复调用不会覆盖。 */
  markTaskDecided(id: string): void;
  upsertBrief(brief: DecisionBrief): void;
  getBrief(taskId: string): DecisionBrief | null;
  /** 反馈延迟：完成 → 首次查看 → 作出决定，p50/p95。 */
  reviewLatency(projectId?: string | null): ReviewLatency;
  /** 验收门禁质量：系统自动判定、系统拦下、待人工与人工收口分布。 */
  gateQuality(projectId?: string | null): GateQuality;
  listTaskEvidence(taskId: string): Evidence[];
  listProjectEvidence(projectId: string): Evidence[];
  appendEvent(input: {
    taskId: string | null;
    workerId?: string | null;
    type: string;
    payload: unknown;
  }): EventRecord;
  listEvents(projectId: string | null, afterId?: number, limit?: number): EventRecord[];
  listRecentEvents(projectId: string | null, limit?: number): EventRecord[];
  listTaskEvents(taskId: string): EventRecord[];
  insertArtifact(input: {
    taskId: string;
    type: ArtifactRecord['type'];
    path: string;
    hash: string;
    meta?: ArtifactRecord['meta'];
  }): ArtifactRecord;
  listArtifacts(projectId: string): ArtifactRecord[];
  listTaskArtifacts(taskId: string): ArtifactRecord[];
  getArtifact(id: string): ArtifactRecord | null;
  insertApproval(input: {
    taskId: string;
    type: string;
    requestedBy: string;
    payload: unknown;
  }): Approval;
  getApproval(id: string): Approval | null;
  listApprovals(projectId: string): Approval[];
  decideApproval(id: string, status: 'approved' | 'rejected', decidedBy: string): Approval;
  insertMessage(input: {
    projectId: string;
    role: Message['role'];
    content: string;
  }): Message;
  listMessages(projectId: string, limit?: number): Message[];
  insertModelCall(input: { workerId: string; model: string; cost: CostLedger }): void;
  sumTaskCost(taskId: string): CostLedger;
  sumProjectCostSince(projectId: string, since: number): number;
  projectCostReport(projectId: string): ProjectCostReport;
  insertSchedule(input: {
    projectId: string;
    title: string;
    goal: string;
    templateId: string | null;
    intervalMinutes: number;
    enabled: boolean;
    nextRunAt: number;
  }): Schedule;
  listSchedules(projectId?: string | null): Schedule[];
  /** 到点且启用的定时任务，按 nextRunAt 升序。 */
  listDueSchedules(at: number): Schedule[];
  getSchedule(id: string): Schedule | null;
  updateSchedule(
    id: string,
    patch: Partial<
      Pick<
        Schedule,
        | 'title'
        | 'goal'
        | 'templateId'
        | 'intervalMinutes'
        | 'enabled'
        | 'nextRunAt'
        | 'lastRunAt'
        | 'lastTaskId'
      >
    >,
  ): Schedule;
  deleteSchedule(id: string): boolean;
}

export interface EventService {
  publish(event: EventRecord): void;
  subscribe(listener: (event: EventRecord) => void): () => void;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): () => void;
  emit(event: string, payload: unknown): void;
  parallel(event: string, payload: unknown): Promise<void>;
}

export interface RepositoryDiff {
  ref: string;
  files: number;
  additions: number;
  deletions: number;
  paths: string[];
}

export interface RepositoryState {
  branch: string;
  head: string;
  clean: boolean;
  diffs: RepositoryDiff[];
}

export interface WorktreeService {
  create(
    project: Project,
    task: Task,
    baseRefs?: string[],
  ): Promise<{ path: string; branch: string }>;
  remove(repoPath: string, worktreePath: string): Promise<void>;
  /** 交付前检查：当前分支、工作区是否干净，以及各分支相对基线的 diff。 */
  inspect(project: Project, refs: string[]): Promise<RepositoryState>;
  /** 将分支依次合入默认分支；任一步失败都回滚到合并前的提交。 */
  merge(
    project: Project,
    refs: string[],
  ): Promise<{ baseBranch: string; head: string; branches: string[] }>;
}

export interface RuntimeRegistry {
  register(adapter: RuntimeAdapter): () => void;
  get(name: string): RuntimeAdapter | undefined;
  list(): RuntimeAdapter[];
  health(): Promise<RuntimeStatus>;
}

export interface VerifyInput {
  taskId: string;
  worktree: string;
  criteria: AcceptanceCriterion[];
  artifacts: ArtifactRef[];
  /** 交付物形态；决定来源/断言校验路径。 */
  profile?: DeliverableProfile;
  /** 无文件产物时的正文（如只读调研报告），用于来源校验。 */
  deliverableText?: string;
  /** 子任务当前分支的基线，用于复算 diff。 */
  baseRef?: string;
}

export interface VerificationResult {
  records: AcceptanceRecord[];
  evidence: Evidence[];
}

/** 验收复核：只依据可复现证据给结论，不采信执行者自报。 */
export interface VerificationService {
  verify(input: VerifyInput): Promise<VerificationResult>;
}

export interface SupervisionInput {
  task: Task;
  worker: Worker;
  /** 该任务近期事件，按时间升序。 */
  recentEvents: EventRecord[];
  now: number;
  /** 本次 run 的开始时间。 */
  startedAt: number;
}

/** 规则监察：纯计算、可单测；不得调用 LLM。 */
export interface SupervisionService {
  inspect(input: SupervisionInput): SupervisionVerdict;
  explain?(verdict: SupervisionVerdict, input: SupervisionInput): Promise<string>;
}

/** 员工注册表：每个角色只允许一个员工插件占用，后者注册即报错。 */
export interface EmployeeRegistry {
  register(definition: Omit<EmployeeDefinition, 'pluginId'>, pluginId: string): () => void;
  get(role: RoleName): EmployeeDefinition | undefined;
  list(): EmployeeDefinition[];
}

/** 任务模板注册表：内置与外部插件都通过它登记，界面只读不写。 */
export interface TemplateRegistry {
  register(template: Omit<TaskTemplate, 'pluginId'>, pluginId: string): () => void;
  get(id: string): TaskTemplate | undefined;
  list(): TaskTemplate[];
}

export interface PlanEdge {
  fromTaskId: string;
  toTaskId: string;
}

export interface PlanResult {
  root: TaskContract;
  children: TaskContract[];
  edges: PlanEdge[];
}

export interface PlannerService {
  plan(project: Project, request: CreatePlanRequest): PlanResult | Promise<PlanResult>;
  status(): PlannerStatus | Promise<PlannerStatus>;
}

/**
 * 记忆库：写入经过门槛校验，检索为关键词 + 时间衰减混合排序。
 * SQLite 为唯一事实来源，Markdown 只是导出快照。
 */
export interface MemoryService {
  remember(candidate: MemoryCandidate): MemoryWriteResult;
  recall(query: string, options?: { projectId?: string | null; limit?: number }): MemoryMatch[];
  /** 全库检索（含所有项目与全局），不改变使用统计，用于跨项目查找。 */
  search(query: string, options?: { limit?: number }): MemoryMatch[];
  list(projectId?: string | null): MemoryEntry[];
  remove(id: string): boolean;
  report(projectId?: string | null): MemoryReport;
  stats(projectId?: string | null): MemoryStats;
}

export type SecretSource = 'vault' | 'env' | 'none';

/**
 * 密钥托管：`get` 先读本地加密仓库，未命中再看环境变量；
 * 仓库实现保证明文不落盘（Windows 使用 DPAPI）。
 */
export interface SecretsService {
  readonly backend: string;
  get(name: string): Promise<string | null>;
  source(name: string): Promise<SecretSource>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface SchedulerService {
  start(): void;
  stop(): Promise<void>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  /** 向任务投递人的中途消息；running 且运行时支持时立即送达，否则排队等下次派发。 */
  deliverInput(
    taskId: string,
    text: string,
    source?: TaskInput['source'],
  ): Promise<{ input: TaskInput; delivery: 'delivered' | 'queued' }>;
}

export interface StewardService {
  snapshot(projectId?: string | null): Promise<WorkbenchSnapshot>;
  createProject(request: CreateProjectRequest): Promise<Project>;
  createPlan(
    projectId: string,
    request: CreatePlanRequest,
  ): Promise<{ root: Task; children: Task[] }>;
  approveTask(taskId: string): Task;
  rejectTask(taskId: string, note?: string): Task;
  cancelTask(taskId: string): Promise<Task>;
  pauseTask(taskId: string): Promise<Task>;
  resumeTask(taskId: string): Promise<Task>;
  retryTask(taskId: string): Task;
  reassignTask(taskId: string, role: RoleName, note?: string): Promise<Task>;
  decideAcceptance(
    taskId: string,
    decisions: AcceptanceDecision[],
    judgedByUser?: string,
  ): Task;
  markViewed(taskId: string): Task;
  /** 决策说明：由系统按契约与复核结果生成，员工自述不参与。 */
  brief(taskId: string): DecisionBrief;
  /** 交付说明 + 一键合并计划；说明复用决策说明，不另造叙述。 */
  delivery(taskId: string): Promise<DeliveryPlan>;
  mergeDelivery(
    taskId: string,
    request: { confirm: boolean; planHash: string },
  ): Promise<{ plan: DeliveryPlan; result: DeliveryMergeResult }>;
  /** 逐文件 diff：给「改了什么」提供可展开明细，根任务汇总子任务。 */
  diffReview(taskId: string): DiffReview;
  summary(taskId: string): string;
  replay(taskId: string): TaskReplay;
  decideApproval(id: string, status: 'approved' | 'rejected'): Approval;
  updateAssistant(
    patch: Partial<Pick<Assistant, 'name' | 'avatar' | 'persona' | 'tone' | 'proactivity'>>,
  ): Assistant;
  updateProjectSettings(
    projectId: string,
    patch: { dailyBudgetUsd?: number; maxConcurrency?: number },
  ): Project;
}

export interface HttpRouteRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
}

export interface HttpReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export type HttpHandler = (request: HttpRouteRequest) => Promise<HttpReply> | HttpReply;
export type HttpRawHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  params: Record<string, string>,
) => void | Promise<void>;

export interface HttpService {
  route(method: string, pattern: string, handler: HttpHandler): () => void;
  rawRoute(method: string, pattern: string, handler: HttpRawHandler): () => void;
  listen(port: number): Promise<number>;
  port(): number;
  close(): Promise<void>;
}

/**
 * 定时任务：按固定间隔为项目预生成任务单。
 * 到点只落一张待审批任务单，不自动开工，也不降低验收强度。
 */
export interface ScheduleService {
  list(projectId?: string | null): Schedule[];
  create(input: {
    projectId: string;
    title: string;
    goal: string;
    templateId?: string | null;
    intervalMinutes: number;
    enabled?: boolean;
  }): Schedule;
  setEnabled(id: string, enabled: boolean): Schedule;
  remove(id: string): boolean;
  /** 立即触发一次；与到点触发走同一条路径。 */
  run(id: string): Promise<ScheduleRun>;
  /** 到点检查；插件内部定时调用，测试可直接驱动。 */
  tick(at?: number): Promise<ScheduleRun[]>;
}

/**
 * 全局路由：把一句话目标映射到最合适的已有项目。
 * 只做本地规则打分并给出依据，不建单、不改项目状态。
 */
export interface RouterService {
  route(goal: string): RouteSuggestion[];
}

export interface ServiceMap {
  config: OpenCoxswainConfig;
  events: EventService;
  storage: StorageService;
  worktrees: WorktreeService;
  runtimes: RuntimeRegistry;
  employees: EmployeeRegistry;
  templates: TemplateRegistry;
  verification: VerificationService;
  supervisor: SupervisionService;
  planner: PlannerService;
  memory: MemoryService;
  scheduler: SchedulerService;
  steward: StewardService;
  schedules: ScheduleService;
  router: RouterService;
  secrets: SecretsService;
  http: HttpService;
}

/** 服务键清单是唯一事实来源：外部清单校验与内核服务表共用这一份。 */
export const SERVICE_KEYS = [
  'config',
  'events',
  'storage',
  'worktrees',
  'runtimes',
  'employees',
  'templates',
  'verification',
  'supervisor',
  'planner',
  'memory',
  'scheduler',
  'steward',
  'schedules',
  'router',
  'secrets',
  'http',
] as const satisfies readonly (keyof ServiceMap)[];

export type ServiceKey = (typeof SERVICE_KEYS)[number];
