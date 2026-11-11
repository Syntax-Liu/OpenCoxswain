/**
 * 事件总线：把 `Orchestrator` 的运行时事件变成可重放的序列。
 *
 * 为什么需要重放缓冲（比 legacy 的 SSE 更严）：
 * SSE 客户端断线重连时，中间发生的事件会丢。如果丢的是
 * `executor_settled` 或 `report`，界面就会永久显示一个已经结束的执行者"还在跑"。
 *
 * 做法：
 * - 每个事件带单调递增的 `seq`；
 * - 保留最近 `bufferSize` 条；
 * - 客户端带 `after=seq` 重连时，先补发缓冲里它错过的，再开始收新的；
 * - 如果它错过的太多（超出缓冲），返回一个 `gap` 事件，客户端据此**整页重拉快照**，
 *   而不是假装没断过。
 */
import type { RuntimeEvent } from '../orchestrator.js';

export interface BusEvent {
  readonly seq: number;
  readonly at: number;
  readonly event: RuntimeEvent;
}

/** 客户端错过的太多时的提示事件。 */
export interface GapEvent {
  readonly seq: number;
  readonly at: number;
  readonly event: { readonly type: 'gap'; readonly reason: string };
}

export type OutboundEvent = BusEvent | GapEvent;

export type Subscriber = (item: OutboundEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly buffer: BusEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly bufferSize: number;

  constructor(bufferSize = 500) {
    this.bufferSize = bufferSize;
  }

  /** 当前最新序列号（快照里告诉客户端"你拿到的是这个位置"）。 */
  get lastSeq(): number {
    return this.seq;
  }

  publish(event: RuntimeEvent): void {
    this.seq += 1;
    const item: BusEvent = { seq: this.seq, at: Date.now(), event };
    this.buffer.push(item);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(item);
      } catch {
        // 单个订阅者出错不能影响其它订阅者
      }
    }
  }

  /**
   * 订阅，并补发 `after` 之后错过的事件。
   *
   * @param after 客户端已收到的最后 seq。
   *   - `0` = 全新客户端，它尚未持有任何状态，会自己拉快照，**不报缺口**；
   *   - `>0` = 断线重连，此时才需要判断是否错过太多。
   * @returns 取消订阅函数。
   */
  subscribe(subscriber: Subscriber, after = 0): () => void {
    // 先补发历史，再登记实时订阅 —— 顺序反了会漏掉补发期间产生的事件。
    const replay = this.buffer.filter((item) => item.seq > after);
    const earliest = this.buffer[0]?.seq ?? this.seq + 1;

    if (after > 0 && after < earliest - 1) {
      // 缓冲已经滚过了它需要的那段：明确告知有缺口，让它重拉快照。
      subscriber({
        seq: this.seq,
        at: Date.now(),
        event: {
          type: 'gap',
          reason: `你错过的 ${earliest - after - 1} 条事件已超出缓冲（保留最近 ${this.bufferSize} 条），请重新拉取快照`,
        },
      });
    }

    for (const item of replay) {
      try {
        subscriber(item);
      } catch {
        // 忽略单个失败
      }
    }

    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
