/**
 * 宿主能力边界。
 *
 * 本机安装的 dsh 在 asar 里剥掉了大部分 `.d.ts`，插件不能无条件 import
 * `@deepseek-ai/dsh-*` 的类型来"确认"宿主存在。这里做两件事：
 *
 * 1. 只声明**我们真正用到**的宿主面，最小化耦合；
 * 2. 在 apply 阶段做一次运行时探测，缺什么就给出**可读原因**，
 *    而不是让插件静默加载、派活永远不工作。
 *
 * 类型依据见 docs/verify/p0-findings.md（每条都标了上游文件与行号）。
 */
import type { Agent } from './host-types.js';

// ---------------------------------------------------------------------------
// ctx.agents —— C 的常驻与 D 的追问都压在这里（P0-T1 / P0-T3）
// ---------------------------------------------------------------------------

export interface AgentHandleLike {
  readonly agent: Agent;
  dispose(): Promise<void>;
}

export interface CreateAgentOptionsLike {
  readonly sessionId: string;
  /** 省略即根 Agent —— 正是 C 需要的形态。P0-T1 证据 2。 */
  readonly parentAgent?: Agent;
  readonly meta?: {
    readonly cwd?: string;
    readonly parentSession?: string;
    readonly isSeeded?: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  readonly agentOptions?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface ResumeAgentOptionsLike {
  readonly resumeSessionId: string;
  readonly parentAgent?: Agent;
  readonly agentOptions?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export interface AgentRegistryLike {
  create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  resume(options: ResumeAgentOptionsLike): Promise<AgentHandleLike>;
  /** 取不到返回 undefined 是常态（重启后、句柄已 dispose）。P0-T1 补充验证。 */
  get(id: string): Agent | undefined;
  list(): Agent[];
  roots(): Agent[];
}

// ---------------------------------------------------------------------------
// ctx.subagents —— D 的派发与追问（P0-T2 / P0-T3）
// ---------------------------------------------------------------------------

export interface SubagentStartRequestLike {
  readonly cwd?: string;
  readonly agentPreset?: string;
  readonly prompt: readonly unknown[];
  /** 必须是**活 Agent 对象**，不是 id。 */
  readonly parent: Agent;
  readonly signal: AbortSignal;
}

export interface SubagentResultLike {
  readonly output: readonly unknown[];
  readonly structured?: unknown;
  readonly diagnostic?: string;
  readonly stopReason: string;
}

export interface SubagentActivationLike {
  readonly childId: string;
  readonly messageId?: string;
  readonly result: Promise<SubagentResultLike>;
  dispose(): Promise<void>;
}

export interface SubagentActivationSpecLike {
  readonly provider: string;
  readonly label: string;
  readonly request: SubagentStartRequestLike;
  readonly signal: AbortSignal;
  /** `parent` 让 dsh 自己把结算通知投递给父会话（P0-T2）。 */
  readonly delivery: 'parent' | 'caller';
}

export interface SubagentRuntimeLike {
  startActivation(spec: SubagentActivationSpecLike): Promise<SubagentActivationLike>;
  /**
   * 给直接子代理发消息。目标不在场时**从持久化冷恢复**（P0-T3）。
   * L3：要求精确的活发送方 + 直接可续子代理。
   */
  sendMessage?(
    sender: Agent,
    targetId: string,
    content: readonly unknown[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<string>;
  /** 当前配置的子代理并发上限（默认 8）。L5 / §7.2。 */
  resolveMaxDepth?(configured?: number | 'provider-managed'): number | undefined;
}

// ---------------------------------------------------------------------------
// ctx.tools
// ---------------------------------------------------------------------------

export interface ToolGuardExecutionLike {
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolsServiceLike {
  register(definition: unknown, options?: unknown): () => void;
  guard(guard: (execution: ToolGuardExecutionLike) => string | undefined): () => void;
}

// ---------------------------------------------------------------------------
// ctx.storageDomain
// ---------------------------------------------------------------------------

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
  update(key: string, fn: (current: V) => V): Promise<V>;
}

export interface DomainLike {
  readonly name: string;
  table(name: string): KvTableLike<never>;
  close(): Promise<void>;
}

export interface StorageDomainFacilityLike {
  open(spec: unknown): Promise<DomainLike>;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/** 插件对外可见的宿主能力。某一项为 undefined 表示宿主没提供。 */
export interface HostApi {
  /** C 的创建/恢复/取回、D 的追问入口。 */
  readonly agents: AgentRegistryLike | undefined;
  /** D 的派发。 */
  readonly subagents: SubagentRuntimeLike | undefined;
  readonly storageDomain: StorageDomainFacilityLike | undefined;
  readonly tools: ToolsServiceLike | undefined;
  /** 注册卸载清理。 */
  readonly effect: (dispose: () => void | Promise<void>) => void;
}

export type HostCapability =
  | 'agents'
  | 'subagents'
  | 'storageDomain'
  | 'tools';

/** 宿主能力缺失时的可读汇总，直接进工具返回值与日志。 */
export interface HostCapabilityReport {
  readonly ok: boolean;
  readonly missing: readonly HostCapability[];
  readonly hint: string;
}

const HINTS: Record<HostCapability, string> = {
  agents:
    '宿主未提供 ctx.agents。项目助理 C 是常驻根 Agent，没有它就无法建 C 或恢复 C。' +
    '请确认 dsh 装载了 @deepseek-ai/dsh-agent 与实现了 createAgent 的 @deepseek-ai/dsh-agent-loop。',
  subagents:
    '宿主未提供 ctx.subagents。请确认 dsh 装载了 @deepseek-ai/dsh-subagent 与一个后端插件（如 @deepseek-ai/dsh-subagent-spawn-in-process）。',
  storageDomain:
    '宿主未提供 ctx.storageDomain。请确认 dsh 装载了 @deepseek-ai/dsh-storage-domain 且配置了可用的 storage 后端；' +
    '没有它项目与执行者状态无法跨重启保留（D5 完整恢复也就无从谈起）。',
  tools: '宿主未提供 ctx.tools。没有它无法注册 C 的五个工具与 B 的三个工具。',
};

export function inspectHost(host: HostApi): HostCapabilityReport {
  const missing: HostCapability[] = [];
  if (!host.agents) missing.push('agents');
  if (!host.subagents) missing.push('subagents');
  if (!host.storageDomain) missing.push('storageDomain');
  if (!host.tools) missing.push('tools');
  if (missing.length === 0) {
    return { ok: true, missing, hint: '' };
  }
  const hint = missing.map((name) => HINTS[name]).join('\n');
  return { ok: false, missing, hint };
}
