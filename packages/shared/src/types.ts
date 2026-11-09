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
}

export interface AcceptanceResult {
  criterionId: string;
  status: 'passed' | 'failed' | 'unverified';
  evidence?: string;
  judgedBy: 'system' | 'verifier' | 'human';
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
  summary: string | null;
}
