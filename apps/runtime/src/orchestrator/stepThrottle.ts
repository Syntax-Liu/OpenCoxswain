/**
 * 步骤节流器：把「Agent 每做一件事」合并成「界面上现在在做什么」。
 *
 * ## 为什么需要节流
 *
 * 一个 Agent 一轮可能连续调用十几个工具。每次都广播会给 SSE 和前端
 * 造成毫无必要的压力，而且人类根本读不过来。
 *
 * ## 为什么合并时保留**最后**一条
 *
 * 界面关心的是「现在在做什么」。如果合并时保留第一条，
 * 用户会一直看到一个已经过时的步骤。
 *
 * ## 为什么单独成一个类
 *
 * 这段逻辑原本内联在 `Orchestrator` 的一个 3000 行类里。
 * 它有自己完整的状态机（三个 Map + 一个定时器），
 * 和编排逻辑没有耦合，独立出来才能测、才能改。
 *
 * 行为与拆分前**完全一致**：
 * - 窗口 300ms
 * - 窗口内合并时保留最后一条
 * - 定时器 `unref()`，不拖住进程退出
 */
import type { StepDescription } from '../executor/step.js';

/** 节流窗口（毫秒）。 */
export const STEP_THROTTLE_MS = 300;

/** 节流后真正要广播的一条步骤。 */
export interface ThrottledStep {
  readonly executorId: string;
  readonly projectId: string;
  readonly step: StepDescription;
}

export class StepThrottle {
  /** 每个执行器上次**实际发出**的时间。 */
  private readonly lastEmit = new Map<string, number>();
  /** 窗口内暂存的最新一条，等窗口结束再补发。 */
  private readonly pending = new Map<string, ThrottledStep>();
  /** 每个执行器一个补发定时器。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly emit: (item: ThrottledStep) => void,
    private readonly windowMs: number = STEP_THROTTLE_MS,
    /** 便于测试注入时间源。 */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 报告一次新步骤。
   *
   * @returns 如果立即发出了，返回那一条；如果被并进窗口，返回 null。
   */
  report(executorId: string, projectId: string, step: StepDescription): ThrottledStep | null {
    const current = this.now();
    const last = this.lastEmit.get(executorId);

    // 从没发过 → 立即发出。
    //
    // **不能用 `?? 0` 当默认值**：如果时间源从 0 附近开始（测试里就是这样），
    // `0 - 0 < 300` 恒成立，第一条就被错判成"在窗口内"而挂起。
    // 拆分前这里用的是 `?? 0`，只是因为真实 Date.now() 永远是 13 位大数才没暴露。
    if (last !== undefined && current - last < this.windowMs) {
      // 窗口内：记住最新一条，等窗口结束再补发
      this.pending.set(executorId, { executorId, projectId, step });
      if (!this.timers.has(executorId)) {
        const timer = setTimeout(() => {
          this.timers.delete(executorId);
          const pending = this.pending.get(executorId);
          if (!pending) return;
          this.pending.delete(executorId);
          this.lastEmit.set(executorId, this.now());
          this.emit(pending);
        }, this.windowMs);
        // 不要让定时器拖住进程退出
        timer.unref?.();
        this.timers.set(executorId, timer);
      }
      return null;
    }

    this.lastEmit.set(executorId, current);
    const item: ThrottledStep = { executorId, projectId, step };
    this.emit(item);
    return item;
  }

  /** 某个执行器结束后清掉它的状态，避免 Map 无限增长。 */
  forget(executorId: string): void {
    const timer = this.timers.get(executorId);
    if (timer) clearTimeout(timer);
    this.timers.delete(executorId);
    this.pending.delete(executorId);
    this.lastEmit.delete(executorId);
  }

  /** 当前还有多少执行器处于节流状态（调试/测试用）。 */
  size(): number {
    return this.lastEmit.size;
  }

  /** 进程关闭前清干净所有定时器。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.lastEmit.clear();
  }
}
