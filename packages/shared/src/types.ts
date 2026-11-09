export const TASK_STATUSES = [
  'draft',
  'planning',
  'awaiting_approval',
  'queued',
  'running',
  'awaiting_review',
  'paused',
  'blocked',
  'failed',
  'done',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ROLE_NAMES = ['researcher', 'implementer', 'verifier', 'writer'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ACCEPTANCE_TYPES = ['command', 'diff', 'rubric', 'human'] as const;
export type AcceptanceType = (typeof ACCEPTANCE_TYPES)[number];

export const EVIDENCE_KINDS = [
  'command_output',
  'diff_stat',
  'file',
  'screenshot',
  'link',
  'human_note',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const VERDICTS = ['passed', 'failed', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DELIVERABLE_TYPES = ['diff', 'file', 'report', 'link'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const WORKER_STATUSES = [
  'starting',
  'running',
  'paused',
  'done',
  'failed',
  'terminated',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface AcceptanceCriterion {
  id: string;
  type: AcceptanceType;
  desc: string;
  check?: string;
  /** 该条至少需要哪些证据；缺省时由 type 推导。 */
  evidence_required?: EvidenceKind[];
}

/** 一条可复核的证据。执行者只能提交，不能据此判定。 */
export interface Evidence {
  id: string;
  taskId: string;
  criterionId: string;
  kind: EvidenceKind;
  /** command: 命令行；diff: 比较基线；file: 路径；human_note: 判断理由 */
  ref: string;
  /** 输出摘要 / diff 统计 / 内容 sha256 */
  digest: string;
  producedBy: 'system' | 'verifier' | 'worker' | 'human';
  createdAt: number;
}

/** 系统或人给出的验收判定。每条标准最终只保留一条记录。 */
export interface AcceptanceRecord {
  taskId: string;
  criterionId: string;
  verdict: Verdict;
  evidenceIds: string[];
  judgedBy: 'system' | 'verifier' | 'human';
  judgedByUser?: string;
  note?: string;
  at: number;
}

/** 用户逐条验收的输入。 */
export interface AcceptanceDecision {
  criterionId: string;
  verdict: 'passed' | 'failed';
  /** 必填：人的判断理由。 */
  note: string;
}

export const INPUT_SOURCES = ['human', 'supervisor', 'task'] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];

export const INPUT_STATES = ['pending', 'delivered', 'queued', 'consumed', 'rejected'] as const;
export type InputState = (typeof INPUT_STATES)[number];

/** 投递给运行中任务的输入；delivered 表示运行时确认收到，queued 表示只能下次派发时注入。 */
export interface TaskInput {
  id: string;
  taskId: string;
  source: InputSource;
  text: string;
  state: InputState;
  createdAt: number;
  deliveredAt?: number;
}

export type SupervisionRule =
  | 'off_scope'
  | 'no_heartbeat'
  | 'repeated_fingerprint'
  | 'stalled'
  | 'budget_slope'
  | 'long_tail'
  | 'empty_completion';

export type SupervisionVerdict =
  | { kind: 'ok' }
  | { kind: 'nudge'; rule: SupervisionRule; reason: string; message: string }
  | { kind: 'pause'; rule: SupervisionRule; reason: string }
  | { kind: 'fail'; rule: SupervisionRule; reason: string }
  | { kind: 'ask_human'; rule: SupervisionRule; reason: string; question: string };

export interface SupervisionAction {
  id: string;
  taskId: string;
  workerId: string | null;
  rule: SupervisionRule;
  verdict: 'nudge' | 'pause' | 'fail' | 'ask_human';
  reason: string;
  at: number;
}

export interface AcceptanceResult {
  criterionId: string;
  status: Verdict;
  evidence?: string;
  judgedBy: 'system' | 'verifier' | 'human';
}

export const TASK_STAGE_KINDS = ['person', 'working', 'idle'] as const;
export type TaskStageKind = (typeof TASK_STAGE_KINDS)[number];

/** 「在等谁」的计算视图，不落库、不改状态机。 */
export type TaskStage =
  | { kind: 'person'; reason: 'answer' | 'review' | 'blocked' | 'failed'; detail: string }
  | { kind: 'working'; reason: 'queued' | 'running' }
  | { kind: 'idle'; reason: 'waiting_dependency' | 'waiting_input' };

export interface TaskStageView {
  taskId: string;
  stage: TaskStage;
}

export interface Deliverable {
  type: DeliverableType;
  scope?: string;
}

export interface Budget {
  tokens?: number;
  usd?: number;
  minutes?: number;
}

export interface Assignee {
  role: RoleName;
  runtime: string;
  model: string;
}

export interface ReviewSpec {
  required: boolean;
  reviewer_role?: RoleName;
}

/** 任务单契约。字段与 PRD 附录 A 保持一致。 */
export interface TaskContract {
  task_id: string;
  parent_id: string | null;
  project_id: string;
  title: string;
  goal: string;
  context_refs?: string[];
  inputs?: Record<string, unknown>;
  deliverables: Deliverable[];
  constraints?: string[];
  acceptance_criteria: AcceptanceCriterion[];
  dependencies: string[];
  write_scope?: string[];
  assignee?: Assignee;
  budget: Budget;
  review?: ReviewSpec;
  deadline?: string;
}

export interface CostLedger {
  tokensIn: number;
  tokensOut: number;
  usd: number;
  minutes: number;
}

export interface ArtifactRef {
  id?: string;
  type: DeliverableType;
  path: string;
  label?: string;
  meta?: {
    files?: number;
    additions?: number;
    deletions?: number;
  };
}

export interface WorkerResult {
  summary: string;
  artifacts: ArtifactRef[];
  acceptance: AcceptanceResult[];
  cost: CostLedger;
  logsRef: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  dailyBudgetUsd: number;
  maxConcurrency: number;
  createdAt: number;
}

export interface Assistant {
  id: string;
  name: string;
  avatar: string;
  persona: string;
  tone: 'concise' | 'detailed';
  proactivity: 'ask_first' | 'act_first';
  createdAt: number;
}

export interface Task {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  assigneeId: string | null;
  contract: TaskContract;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEdge {
  fromTaskId: string;
  toTaskId: string;
  type: string;
}

/**
 * 员工插件包的五件套：角色、技能、工具白名单、权限声明、默认验收标准。
 * 员工只能由插件注册（`employee:provide`），内核与调度器不内置任何角色。
 */
export interface EmployeeDefinition {
  id: string;
  role: RoleName;
  name: string;
  description: string;
  version: string;
  skills: string[];
  tools: string[];
  permissions: string[];
  readOnly: boolean;
  acceptanceDefaults: AcceptanceCriterion[];
  outputSchema: string;
  /** 提供该员工的插件 id，用于审计“员工来自哪个插件包”。 */
  pluginId: string;
}

export interface Worker {
  id: string;
  taskId: string;
  role: RoleName;
  runtime: string;
  model: string;
  worktreePath: string;
  branch: string;
  sessionRef: string | null;
  status: WorkerStatus;
  cost: CostLedger;
  createdAt: number;
  updatedAt: number;
}

export interface EventRecord {
  id: number;
  taskId: string | null;
  workerId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  type: DeliverableType;
  path: string;
  hash: string;
  meta?: ArtifactRef['meta'];
  createdAt: number;
}

export interface Approval {
  id: string;
  taskId: string;
  type: string;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedBy: string | null;
  decidedAt: number | null;
  payload: unknown;
  createdAt: number;
}

export interface Message {
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

export interface RuntimeStatus {
  adapter: string;
  ok: boolean;
  detail: string;
}

export interface WorkbenchSnapshot {
  projects: Project[];
  project: Project | null;
  assistant: Assistant;
  tasks: Task[];
  edges: TaskEdge[];
  workers: Worker[];
  events: EventRecord[];
  approvals: Approval[];
  messages: Message[];
  artifacts: ArtifactRecord[];
  employees: EmployeeDefinition[];
  acceptance: AcceptanceRecord[];
  evidence: Evidence[];
  stages: TaskStageView[];
  inputs: TaskInput[];
  summary: string | null;
  runtime: RuntimeStatus;
}

export interface SubtaskDraft {
  title: string;
  goal: string;
  role: RoleName;
  dependsOn?: number[];
  deliverables?: Deliverable[];
  acceptance?: AcceptanceCriterion[];
  constraints?: string[];
  writeScope?: string[];
  inputs?: Record<string, unknown>;
  budget?: Budget;
  reviewRequired?: boolean;
}

export interface CreatePlanRequest {
  goal: string;
  acceptanceCommand?: string;
  budget?: Budget;
  dailyBudgetUsd?: number;
  subtasks?: SubtaskDraft[];
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
  dailyBudgetUsd?: number;
  maxConcurrency?: number;
}

export interface CostBreakdownRow {
  key: string;
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ProjectCostReport {
  totalUsd: number;
  tokensIn: number;
  tokensOut: number;
  byModel: CostBreakdownRow[];
  byTask: Array<{ taskId: string; title: string; usd: number }>;
  daily: Array<{ day: string; usd: number }>;
}

export interface TaskReplay {
  task: Task;
  children: Task[];
  edges: TaskEdge[];
  workers: Worker[];
  events: EventRecord[];
  artifacts: ArtifactRecord[];
  approvals: Approval[];
  acceptance: AcceptanceRecord[];
  evidence: Evidence[];
  supervision: SupervisionAction[];
  summary: string | null;
}
