import type {
  ArtifactRef,
  CostLedger,
  RoleName,
  TaskContract,
  WorkerResult,
} from '@opencoxswain/shared';
import type { ApprovalGate } from './guard.js';

export interface RoleTemplate {
  name: RoleName;
  allowedTools: string[];
  readOnly: boolean;
  outputSchema: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  apiKeyRef: string;
  maxTokens: number;
  temperature?: number;
}

export interface ApprovalPolicy {
  requireHumanFor: Array<'delete' | 'push' | 'publish' | 'pay' | 'external_send'>;
  autoApproveUnderUsd?: number;
}

export interface SessionOptions {
  taskId: string;
  worktree: string;
  role: RoleTemplate;
  model: ModelConfig;
  approvalPolicy: ApprovalPolicy;
  env: Record<string, string>;
  /** 危险动作闸门；支持原生闸门的运行时在动作执行前调用。 */
  gate?: ApprovalGate;
}

export interface RuntimeSession {
  readonly id: string;
  readonly taskId: string;
  readonly worktree: string;
  readonly options: SessionOptions;
  cancelled: boolean;
  paused: boolean;
}

export interface HealthStatus {
  ok: boolean;
  detail: string;
}

export interface RuntimeCapabilities {
  /** 能否向运行中的会话追加输入。 */
  input: boolean;
  /** 是否支持执行前挂起并等待人审。 */
  approvalGate: boolean;
  /** 能否从 checkpoint 恢复。 */
  resume: boolean;
}

export interface InputDelivery {
  id: string;
  text: string;
  source: 'human' | 'supervisor' | 'task';
  at: number;
}

export type InputReceipt = 'delivered' | 'queued' | 'unsupported';

export type RuntimeEvent =
  | { type: 'started'; at: number }
  | { type: 'message'; at: number; text: string }
  | { type: 'tool_call'; at: number; tool: string; input: unknown }
  | { type: 'tool_result'; at: number; tool: string; output: unknown }
  | { type: 'artifact'; at: number; artifact: ArtifactRef }
  | { type: 'cost'; at: number; cost: CostLedger }
  | { type: 'progress'; at: number; percent: number; note?: string }
  | { type: 'input_received'; at: number; inputId: string }
  | { type: 'heartbeat'; at: number; phase: string; note?: string }
  | { type: 'error'; at: number; message: string; retryable: boolean }
  | { type: 'finished'; at: number; result: WorkerResult };

export interface RuntimeAdapter {
  readonly name: string;
  readonly version: string;
  readonly capabilities: RuntimeCapabilities;
  /** 是否能在动作执行前挂起并等待人审；false 时由调度器在事件边界冻结。 */
  readonly supportsApprovalGate: boolean;

  createSession(opts: SessionOptions): Promise<RuntimeSession>;
  send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent>;
  cancel(session: RuntimeSession): Promise<void>;
  collect(session: RuntimeSession): Promise<WorkerResult>;
  dispose(session: RuntimeSession): Promise<void>;
  healthCheck(): Promise<HealthStatus>;

  /** 可选实现；capabilities.input=false 时调度器必须拒绝，不得静默丢弃。 */
  sendInput?(session: RuntimeSession, input: InputDelivery): Promise<InputReceipt>;

  /** v0 暂停/继续需要保留现场；实现方可选支持。 */
  pause?(session: RuntimeSession): Promise<void>;
  resume?(session: RuntimeSession): Promise<void>;
}
