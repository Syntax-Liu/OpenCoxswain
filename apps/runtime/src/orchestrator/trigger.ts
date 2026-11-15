/**
 * Trigger：状态变化驱动的唤醒机制。
 *
 * ## 为什么需要（对齐 DSH 的设计）
 *
 * DSH Super-Agent 的架构文档里，投递给主 Session 的消息**分两类**：
 *
 * ```
 * 「这些消息会被引导到主 Session 的轮次中」        ← 唤醒，让它跑一轮
 *     follow_up       执行器看到的消息
 *     worker_report   工单卡片、原始触发、状态、摘要
 *
 * 「其他通知在不唤醒主 Session 的情况下注入」      ← 只记录，不唤醒
 *     ticket_ended、settings_saved、提示词保存、触发重新排队…
 * ```
 *
 * **这个区分是核心**：同样是"状态改变了"，有的要人（模型）来处理，
 * 有的只是留个档。
 *
 * ## 我们踩过的坑
 *
 * 2026-11-15 用户反馈："Agent 跑完了，Assistant 没有及时汇报结果"。
 *
 * 我们的问题是**所有状态变化都走同一条路**：
 *
 *   结算通知 → 投进 inbox → pumpAssistant
 *
 * 于是"该汇报"和"该派活"混在一轮里，加上谎报检测重试，
 * 汇报就被顶掉了。
 *
 * ## 现在的做法
 *
 * 每个状态变化产生一个 Trigger，带 `kind` 和 `wake`：
 *
 *   - `wake: true`  → 投进 inbox 并唤醒 Assistant（要它说话）
 *   - `wake: false` → 只记录进台账/事件流（不需要它说话）
 *
 * 唤醒与否由下面的 `TRIGGER_WAKE` 表决定，**不散落在调用点**。
 */

/** 会产生 trigger 的状态变化。 */
export type TriggerKind =
  /** 用户说话了。 */
  | 'user_message'
  /** Agent 完成了（要 Assistant 汇报结果）。 */
  | 'worker_report'
  /** Agent 卡住了，等用户拍板。 */
  | 'worker_attention'
  /** Agent 被取消了（只是记录，不打断 Assistant）。 */
  | 'worker_cancelled'
  /** Agent 失败了（要汇报，因为用户得知道）。 */
  | 'worker_failed'
  /** Agent 开始跑了（只是状态变化，不唤醒）。 */
  | 'worker_started'
  /** 审批被拒绝了（要 Assistant 知道，之后别再犯）。 */
  | 'approval_rejected'
  /** 项目配置变了（不需要 Assistant 说话）。 */
  | 'settings_changed'
  /** 定时/模板触发（要 Assistant 动）。 */
  | 'schedule_fired'
  /** 用户从手机上说话。 */
  | 'im_message';

/**
 * 哪些状态变化要唤醒 Assistant。
 *
 * 判据：**用户是否需要被告知**。
 *
 *   - 要用户知道结果 → 唤醒（汇报）
 *   - 要用户做决定   → 唤醒（提示）
 *   - 纯内部状态     → 不唤醒（省一次模型调用）
 */
export const TRIGGER_WAKE: Readonly<Record<TriggerKind, boolean>> = {
  user_message: true,
  // 完成/失败都必须让用户知道——这是"结果没汇报"的教训。
  worker_report: true,
  worker_failed: true,
  // 卡住了要用户拍板。
  worker_attention: true,
  // 取消是用户自己按的，不用再跟他说一遍。
  worker_cancelled: false,
  // 开始跑只是状态，侧栏已经会变。
  worker_started: false,
  approval_rejected: true,
  settings_changed: false,
  schedule_fired: true,
  im_message: true,
};

/** 一个 trigger。 */
export interface Trigger {
  readonly kind: TriggerKind;
  /** 是否唤醒 Assistant 跑一轮。 */
  readonly wake: boolean;
  /**
   * 唤醒时投给 Assistant 的内容。
   *
   * `wake: false` 的 trigger 不需要这个。
   */
  readonly text?: string;
  /** 关联的 Agent（如果有）。 */
  readonly executorId?: string;
}

/** 生成一个 trigger，`wake` 自动按表填。 */
export function makeTrigger(
  kind: TriggerKind,
  extra: { text?: string; executorId?: string } = {},
): Trigger {
  return {
    kind,
    wake: TRIGGER_WAKE[kind],
    ...(extra.text !== undefined ? { text: extra.text } : {}),
    ...(extra.executorId !== undefined ? { executorId: extra.executorId } : {}),
  };
}

/**
 * 这个 trigger 该不该唤醒 Assistant？
 *
 * 除了查表，还有一条额外规则：**`wake: true` 但没内容也没意义**。
 * 没有 text 的 trigger 唤醒也没东西可说，直接不唤醒。
 */
export function shouldWake(trigger: Trigger): boolean {
  if (!trigger.wake) return false;
  // 唤醒必须有内容：否则 Assistant 收到空消息会不知所措。
  return typeof trigger.text === 'string' && trigger.text.trim().length > 0;
}
