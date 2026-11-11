/**
 * 宿主 Agent 的最小结构类型。
 *
 * 真实类型来自 `@deepseek-ai/dsh-agent`，但那是 dsh 内部包，插件不应
 * 依赖它的运行时。这里只声明**我们真正会调用**的成员，其余留白。
 *
 * 依据（docs/verify/p0-findings.md）：
 * - `followup(message)`：排队成下一轮并唤醒 driver。`runtime-types.d.ts:219`
 * - `Agent` 的 `id` 是 SessionId。`types.d.ts:14`
 * - `session` 承载会话日志。`runtime-types.d.ts:167`
 */
export interface Agent {
  /** Agent 所属会话 id（上游为品牌的 SessionId，这里按字符串处理）。 */
  readonly id?: string;
  /** Agent 驱动的活会话。 */
  readonly session?: { readonly id?: string };
  /** 当前生命周期状态。`runtime-types.d.ts:174` */
  readonly status?: 'idle' | 'running';
  /**
   * 排队成下一轮并唤醒。**不打断**当前轮 —— 用户连发的默认入口（P0-T4）。
   */
  followup?(message: unknown): void;
  /** 插到当前轮最近一步边界。仅在"冲突且必须立刻改方向"时用。 */
  steer?(message: unknown): void;
  /** 真正打断当前轮。只在用户点停止时用。 */
  cancel?(cause: unknown, options?: { readonly keepInbox?: boolean }): void;
  /** 等当前活动收敛。 */
  whenIdle?(): Promise<void>;
}

/** 构造一条 user-role 消息。上游是 `createUserMessage`。 */
export function userMessage(text: string, source?: unknown): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    ...(source === undefined ? {} : { source }),
  };
}
