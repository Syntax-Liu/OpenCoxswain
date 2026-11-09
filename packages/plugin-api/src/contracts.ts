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
  EmployeeDefinition,
  EventRecord,
  Evidence,
  Message,
  Project,
  ProjectCostReport,
  RoleName,
  RuntimeStatus,
  SupervisionAction,
  SupervisionVerdict,
  Task,
  TaskContract,
  TaskEdge,
  TaskInput,
  TaskReplay,
  TaskStatus,
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

export type Permission =
  | 'events:publish'
  | 'events:read'
  | 'storage:read'
  | 'storage:write'
  | 'storage:provide'
  | 'fs:data'
  | 'fs:worktree'
  | 'process:spawn'
  | 'runtime:use'
  | 'runtime:provide'
  | 'planner:use'
  | 'scheduler:control'
  | 'steward:call'
  | 'secrets:read'
  | 'secrets:write'
  | 'secrets:provide'
  | 'http:route'
  | 'net:listen'
  | 'employee:use'
  | 'employee:provide'
  | 'verification:run'
  | 'verification:provide'
  | 'supervisor:use'
  | 'supervisor:provide'
  | 'ui:panel';

export interface OpenCoxswainConfig {
  version: string;
  host: string;
  port: number;
  homeDir: string;
  dbPath: string;
  worktreesDir: string;
  artifactsDir: string;
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
}

export interface EventService {
  publish(event: EventRecord): void;
  subscribe(listener: (event: EventRecord) => void): () => void;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): () => void;
  emit(event: string, payload: unknown): void;
  parallel(event: string, payload: unknown): Promise<void>;
}

export interface WorktreeService {
  create(
    project: Project,
    task: Task,
    baseRefs?: string[],
  ): Promise<{ path: string; branch: string }>;
  remove(repoPath: string, worktreePath: string): Promise<void>;
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
  decideAcceptance(
    taskId: string,
    decisions: AcceptanceDecision[],
    judgedByUser?: string,
  ): Task;
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

export interface ServiceMap {
  config: OpenCoxswainConfig;
  events: EventService;
  storage: StorageService;
  worktrees: WorktreeService;
  runtimes: RuntimeRegistry;
  employees: EmployeeRegistry;
  verification: VerificationService;
  supervisor: SupervisionService;
  planner: PlannerService;
  scheduler: SchedulerService;
  steward: StewardService;
  secrets: SecretsService;
  http: HttpService;
}

export type ServiceKey = keyof ServiceMap;
