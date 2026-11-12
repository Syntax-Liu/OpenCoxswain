/**
 * 连发不打断：用户消息的投递队列。
 *
 * 用户要求：
 * > "用户发送后，C 立即回复，无论回复是否载入完全，用户都可以继续发送内容，
 * >  且不打断 C。C 接收到新需求后，判断与上一轮是否冲突。"
 *
 * 实现要点（这是 TRAE 宝文档里"回复指定消息"背后的机制）：
 *
 * 1. **消息永远排队，不打断**：新消息进 `pending`，C 当前这轮跑完（或者
 *    跑到了下一个工具步边界）才会被取走。
 * 2. **两条队列语义不同**：
 *    - `next`：当前这轮结束后单独开新的一轮（默认，对应"连发"）
 *    - `step`：插到当前轮的下一个工具步之前（对应"等等，改一下"）
 * 3. **只有用户点停止才中止**，中止时排队消息保留。
 *
 * 为什么不直接 append 到 messages：那样 C 会在半轮里看到新消息，
 * 相当于打断。必须经过队列，语义才和"不打断"一致。
 */
export type InboxTarget = 'next' | 'step';

export interface InboxItem {
  readonly id: string;
  readonly text: string;
  readonly target: InboxTarget;
  readonly at: number;
  /** 来源：webapp / im / Supervisor转交。 */
  readonly source: string;
  /**
   * 是否是系统内部通知（如执行者结算）。
   *
   * 内部通知要进 C 的上下文，但**不该出现在用户的对话流里**——
   * 那是给模型看的指令，不是用户说的话。
   */
  readonly internal: boolean;
}

export class Inbox {
  private readonly step: InboxItem[] = [];
  private readonly next: InboxItem[] = [];
  private counter = 0;

  /**
   * 投递一条消息。
   *
   * `target='next'` 是默认：排队成后续的一轮。
   * `target='step'` 只用于"必须立刻改方向"的情况。
   */
  push(
    text: string,
    options: { target?: InboxTarget; source?: string; internal?: boolean } = {},
  ): InboxItem {
    this.counter += 1;
    const item: InboxItem = {
      id: `in_${Date.now().toString(36)}${this.counter}`,
      text,
      target: options.target ?? 'next',
      at: Date.now(),
      source: options.source ?? 'webapp',
      internal: options.internal === true,
    };
    if (item.target === 'step') this.step.push(item);
    else this.next.push(item);
    return item;
  }

  /**
   * 取走当前这一步该注入的消息：先 step，再 next。
   *
   * 被循环在每一步开头调用。注意 `step` 队列优先——用户刚发的"改一下"
   * 应该比之前排队的普通消息更早被看到。
   */
  drainForStep(): InboxItem[] {
    const out = [...this.step, ...this.next];
    this.step.length = 0;
    this.next.length = 0;
    return out;
  }

  /** 只看不取，供 UI 显示"排队中 N 条"。 */
  peek(): readonly InboxItem[] {
    return [...this.step, ...this.next];
  }

  get pendingCount(): number {
    return this.step.length + this.next.length;
  }

  /** 中止时**保留**排队消息（用户没说要丢弃）。 */
  retained(): readonly InboxItem[] {
    return this.peek();
  }

  /** 用户明确清空。 */
  clear(): void {
    this.step.length = 0;
    this.next.length = 0;
  }
}
