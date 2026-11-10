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
  'assertion',
  'anchor',
  'provenance',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const VERDICTS = ['passed', 'failed', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const DELIVERABLE_TYPES = ['diff', 'file', 'report', 'link'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

/** 交付物形态：决定系统跑第一遍验收时采用哪组校验。 */
export const DELIVERABLE_PROFILES = ['code', 'document', 'dataset', 'design', 'ops'] as const;
export type DeliverableProfile = (typeof DELIVERABLE_PROFILES)[number];

/** auto = 系统判定即可完成；unverified_only = 仅未决项交人（默认）；always_human = 旧行为。 */
export const ACCEPTANCE_POLICIES = ['auto', 'unverified_only', 'always_human'] as const;
export type AcceptancePolicy = (typeof ACCEPTANCE_POLICIES)[number];

export const WORKER_STATUSES = [
  'starting',
  'running',
  'paused',
  'done',
  'failed',
  'terminated',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export const RUN_STATUSES = ['running', 'orphaned', 'done', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  id: string;
  workerId: string;
  taskId: string;
  attempt: number;
  status: RunStatus;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastHeartbeatAt: number | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

/** 一次执行的租约；过期即视为孤儿，可被重新认领。 */
export interface RunLease {
  runId: string;
  owner: string;
  expiresAt: number;
  lastHeartbeatAt: number;
}

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

/**
 * 验收决策说明：四段说明取代证据堆，供人快速做接受/打回判断。
 * 由总管根据任务契约与系统复核结果生成；员工自述不能替代证据。
 */
export interface DecisionBrief {
  taskId: string;
  /** 改了什么：文件与产物摘要 */
  changed: string;
  /** 为什么：任务目标 */
  why: string;
  /** 验过什么：系统复核（命令重跑、diff 复算）结果 */
  verified: string;
  /** 还有什么风险：未决判断、冲突、不可逆动作 */
  risks: string;
  /** 证据引用（evidence id），呈现层折叠展示 */
  evidenceRefs: string[];
  /** 有冲突或需要人判断时的判定理由 */
  conflictReason: string | null;
  generatedAt: number;
}

/** 反馈延迟指标：完成 → 看到 → 决定。 */
export interface ReviewLatency {
  /** 已完成的验收样本数 */
  samples: number;
  /** 当前仍在等待人决策的任务数 */
  waiting: number;
  viewLagP50: number | null;
  viewLagP95: number | null;
  decideLagP50: number | null;
  decideLagP95: number | null;
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

export const CAPABILITIES = [
  'fs.read',
  'fs.write',
  'net.read',
  'net.send',
  'proc.spawn',
  'secrets.use',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** 任务级授权凭证：不可变；扩权或跨编制改派必须签发新凭证。 */
export interface TaskMandate {
  id: string;
  taskId: string;
  /** 能力集合，不再枚举子路径。 */
  capabilities: Capability[];
  /** 授权根目录（项目工作目录）；写入不得越出根目录。 */
  root: string;
  /** 允许执行该任务的员工角色；改派到编制外必须重签。 */
  roles: RoleName[];
  budget: Budget;
  expiresAt: number;
  issuedBy: 'user' | 'approval';
  issuedAt: number;
}

export const SIDE_EFFECT_KINDS = ['fs.write', 'fs.delete', 'proc.exec', 'net.send'] as const;
export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number];

export const SIDE_EFFECT_STATES = ['pending', 'succeeded', 'failed', 'rejected'] as const;
export type SideEffectState = (typeof SIDE_EFFECT_STATES)[number];

/** 副作用台账：先记账后执行，不可逆动作不承诺撤销。 */
export interface SideEffect {
  id: string;
  taskId: string;
  workerId: string | null;
  runId: string | null;
  kind: SideEffectKind;
  target: string;
  idempotencyKey: string;
  reversible: boolean;
  state: SideEffectState;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewSpec {
  required: boolean;
  reviewer_role?: RoleName;
}

export const DELEGATION_MODES = ['fixed', 'reassign', 'open'] as const;
/** fixed = 编制在规划期固定（v1 唯一允许值）；其余两档留给后续版本。 */
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** 任务单契约。字段与 PRD 附录 A 保持一致。 */
export interface TaskContract {
  task_id: string;
  parent_id: string | null;
  project_id: string;
  plan_id?: string;
  plan_revision?: number;
  /** 谁决定的分工：planner = 结构派生；user = 手动；steward = 仅调整执行者。 */
  delegated_by?: 'planner' | 'user' | 'steward';
  /** 委派模式；v1 只允许 fixed，缺省即 fixed。 */
  delegation_mode?: DelegationMode;
  /** 断点续跑提示，由 adapter 自行解释（通常是 worktree 快照/分支）。 */
  checkpoint?: string;
  title: string;
  goal: string;
  context_refs?: string[];
  inputs?: Record<string, unknown>;
  deliverables: Deliverable[];
  constraints?: string[];
  acceptance_criteria: AcceptanceCriterion[];
  /** 缺省 unverified_only：系统能验完就不打扰人。 */
  acceptance_policy?: AcceptancePolicy;
  /** 交付物形态；缺省由员工包或角色推导。 */
  deliverable_profile?: DeliverableProfile;
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
    /** 产物自报的文件列表，用于与实际 git diff 对照。 */
    paths?: string[];
    /** 产物自报的 patch 内容 hash，用于内容级复算。 */
    patchHash?: string;
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
  /** 项目是否允许员工读取网络（net.read）。 */
  allowNetwork: boolean;
  /** 项目是否允许员工外发消息（net.send）；默认关闭且仍需逐次审批。 */
  allowExternalSend: boolean;
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
  /** 进入待验收的时刻（毫秒）；未进入过为空 */
  finishedAt?: number | null;
  /** 人首次打开验收单的时刻（毫秒）；未打开过为空 */
  firstViewedAt?: number | null;
  /** 人给出验收结论的时刻（毫秒）；未决定过为空 */
  decidedAt?: number | null;
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
  /** 员工声明的能力集合；安装前用于 capability diff。 */
  capabilities: Capability[];
  readOnly: boolean;
  acceptanceDefaults: AcceptanceCriterion[];
  /** 员工默认交付物形态，Planner 可覆盖。 */
  deliverableProfile?: DeliverableProfile;
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

export interface PlannerStatus {
  mode: 'llm' | 'static';
  /** 静态模式的原因；LLM 模式为 null。 */
  reason: string | null;
}

export const MEMORY_KINDS = ['profile', 'project', 'decision', 'lesson'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 一条记忆：文本 + 来源 + 适用范围；supersededBy 表示已被新结论取代。 */
export interface MemoryEntry {
  id: string;
  projectId: string | null;
  kind: MemoryKind;
  key: string | null;
  text: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
  supersededBy: string | null;
}

export interface MemoryCandidate {
  kind: MemoryKind;
  text: string;
  source: string;
  projectId?: string | null;
  key?: string | null;
}

export type MemoryWriteResult =
  | {
      action: 'created' | 'deduped' | 'superseded';
      entry: MemoryEntry;
      supersededId?: string;
    }
  | { action: 'rejected'; reason: string };

export interface MemoryMatch {
  entry: MemoryEntry;
  score: number;
  matched: string[];
  reason: string;
}

export interface MemoryIssue {
  code: 'secret_like' | 'duplicate' | 'conflict' | 'stale' | 'no_source';
  severity: 'warn' | 'info';
  message: string;
  entryId: string | null;
}

export interface MemoryStats {
  total: number;
  byKind: Record<MemoryKind, number>;
  issues: number;
  lastUsedAt: number | null;
}

export interface MemoryReport {
  stats: MemoryStats;
  issues: MemoryIssue[];
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
  planner: PlannerStatus;
  memory: MemoryStats;
  briefs: DecisionBrief[];
  review: ReviewLatency;
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
  acceptancePolicy?: AcceptancePolicy;
  deliverableProfile?: DeliverableProfile;
}

export interface CreatePlanRequest {
  goal: string;
  acceptanceCommand?: string;
  budget?: Budget;
  dailyBudgetUsd?: number;
  subtasks?: SubtaskDraft[];
  acceptancePolicy?: AcceptancePolicy;
  deliverableProfile?: DeliverableProfile;
}

export interface CreateProjectRequest {
  path: string;
  name?: string;
  dailyBudgetUsd?: number;
  maxConcurrency?: number;
  allowNetwork?: boolean;
  allowExternalSend?: boolean;
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
  mandates: TaskMandate[];
  sideEffects: SideEffect[];
  summary: string | null;
}
