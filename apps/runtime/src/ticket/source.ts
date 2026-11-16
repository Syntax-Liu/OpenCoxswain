/**
 * Source：事件流的来源。
 *
 * ## 对齐 DSH 的设计（docs/001-domain.zh-CN.md）
 *
 * > **来源（Source）** — 一条事件流。来源类型是可复用的实现；
 * > 来源实例是某个类型的一份配置：是否运行、监听什么。
 * >
 * > 规则：保存自己的读取位置和自己的机器人身份。
 * > 定义什么算一个事件。**在机器人的自身消息和监听范围之外的触发
 * > 进入领域之前就丢弃它们。**
 * >
 * > 存在的原因：**重启之后不能重放已处理的事件。**
 *
 * ## 我们之前缺什么
 *
 * 有四个入口：Web、IM、命令行、定时。它们各自直接调 `userSays`，
 * **没有统一的地方**回答这几个问题：
 *
 *   - 这条消息是谁发的？该不该接受？
 *   - 重启后会不会重复处理？
 *   - 这个人的话算"明确要求"还是"推断"？
 *
 * ## 这里做什么
 *
 * 一个 Source 抽象 + 准入判定。**不引入新的数据表**——
 * 读取位置用已有的 seq（message 表自增），准入用已有的配置。
 */

/** 我们的四种来源。 */
export type SourceKind = 'web' | 'im' | 'cli' | 'schedule';

/**
 * 这个来源的「接收范围」。
 *
 * 对齐 DSH：范围决定**什么算一个事件**。
 */
export type ReceiveScope =
  /** 只收指向 agent 的消息（提及 / 私信）。 */
  | 'mention-only'
  /** 收全部消息（群里的每句话都进来）。 */
  | 'all';

export interface SourceConfig {
  readonly kind: SourceKind;
  readonly scope: ReceiveScope;
  /** 是否在运行。关掉就不接收。 */
  readonly enabled: boolean;
}

/**
 * 我们的默认配置。
 *
 * - **Web**：用户在本机直接说话，全是给 agent 的 → `mention-only` 等价于全部
 * - **IM**：默认只收群里**@机器人**的消息。收全部会让 bot 被群聊淹没
 * - **CLI**：直接输入，全收
 * - **Schedule**：系统自己触发，全收
 */
export const DEFAULT_SOURCES: Readonly<Record<SourceKind, SourceConfig>> = {
  web: { kind: 'web', scope: 'all', enabled: true },
  // **默认 mention-only**：群里所有消息都进来会让 bot 变得吵闹，
  // 而且它会对无关的话发言——DSH 的哲学是"尽可能少地占用人的注意力"。
  im: { kind: 'im', scope: 'mention-only', enabled: false },
  cli: { kind: 'cli', scope: 'all', enabled: true },
  schedule: { kind: 'schedule', scope: 'all', enabled: true },
};

/** 一条来自某个来源的消息。 */
export interface InboundEvent {
  readonly source: SourceKind;
  /** 谁发的。本机用户为 'local-user'。 */
  readonly actor: string;
  readonly text: string;
  /**
   * 这条消息是不是**指向 agent** 的。
   *
   * Web/CLI 天然指向（用户就是在跟它说话）；
   * IM 要看有没有 @ 到机器人。
   */
  readonly mentionsAgent: boolean;
}

export type AdmissionDecision =
  | { readonly accept: true; readonly scope: ReceiveScope }
  | { readonly accept: false; readonly reason: string };

/**
 * 准入判定。
 *
 * 对齐 DSH：*在监听范围之外的触发进入领域之前就丢弃它们。*
 *
 * **必须在这里丢弃，不能等到了 Assistant 再判断**——
 * 一旦进了上下文，模型就会对它发言，用户就看到了一条无中生有的回复。
 */
export function admit(event: InboundEvent, config: SourceConfig): AdmissionDecision {
  if (!config.enabled) {
    return { accept: false, reason: `${event.source} 来源已关闭` };
  }

  if (!event.text.trim()) {
    return { accept: false, reason: '空消息' };
  }

  // 接收范围是 mention-only 时，没指向 agent 的直接丢。
  if (config.scope === 'mention-only' && !event.mentionsAgent) {
    return {
      accept: false,
      reason: `${event.source} 只接 @ 机器人的消息，这条没提到它`,
    };
  }

  return { accept: true, scope: config.scope };
}

/**
 * 来源决定的**授权强度**。
 *
 * 对齐 DSH 的准入表：不同来源、不同指向方式，
 * 授予的强度不同（明确 / 推断）。
 *
 * ```
 * Web / CLI 里用户直接说的话        → explicit（明确要求）
 * IM 里 @ 机器人的话                → explicit（他就是在叫它干活）
 * IM 群里没 @ 但收全部消息时的跟帖   → inferred（只能是推断）
 * 定时 / 模板                       → automatic（系统按规则）
 * ```
 */
export function strengthOf(event: InboundEvent): 'explicit' | 'inferred' | 'automatic' {
  if (event.source === 'schedule') return 'automatic';
  if (event.mentionsAgent) return 'explicit';
  // 没点到它的消息只能算推断——模型得自己判断"这是不是要我做事"。
  return 'inferred';
}
