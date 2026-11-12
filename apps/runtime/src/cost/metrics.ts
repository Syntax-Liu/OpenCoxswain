/**
 * 运行指标（**不做计费**）。
 *
 * 设计决策：不估算金额。
 *
 * 理由（用户明确指出的）：
 * - 不同模型单价不同，且厂商随时调整；
 * - 软件是离线的，无法获取实时价格；
 * - 用户本来就能在服务商后台看到真实账单。
 *
 * 所以这里只呈现**模型自己报告的真实数字**：轮次、步数、token 用量、
 * 吞吐、缓存命中。这些不需要任何假设，也不会因为价格变动而失真。
 *
 * 唯一的例外是 `tokenGuard`：它不是计费，是**止损线**——
 * 防止一个失控的Agent把额度烧光，超了直接停。
 */
import type { CostLedger } from '../cost/budget.js';

export interface RunMetrics {
  /** 模型往返轮次（一次 llm.chat = 一轮）。 */
  readonly turns: number;
  /** 工具调用步数。 */
  readonly steps: number;
  /** 输入 token（含缓存命中部分）。 */
  readonly tokensIn: number;
  /** 输出 token。 */
  readonly tokensOut: number;
  /** 缓存命中的输入 token；模型未报告时为 null（不是 0）。 */
  readonly cachedTokens: number | null;
  /** 实际耗时（毫秒）。 */
  readonly durationMs: number;
  /** 最后一轮的上下文占用（prompt tokens）；未报告时 null。 */
  readonly contextTokens: number | null;
}

export const EMPTY_METRICS: RunMetrics = {
  turns: 0,
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  cachedTokens: null,
  durationMs: 0,
  contextTokens: null,
};

export function totalTokens(m: Pick<RunMetrics, 'tokensIn' | 'tokensOut'>): number {
  return m.tokensIn + m.tokensOut;
}

/** 吞吐：输出 token / 秒。耗时为 0 时返回 null（不编数字）。 */
export function tokensPerSecond(m: RunMetrics): number | null {
  if (m.durationMs <= 0 || m.tokensOut <= 0) return null;
  return m.tokensOut / (m.durationMs / 1000);
}

/**
 * 缓存命中率。
 *
 * 模型没报告缓存字段时返回 **null 而不是 0**——
 * "没有这个数据"和"命中率为零"是两回事，不能混为一谈。
 */
export function cacheHitRate(m: RunMetrics): number | null {
  if (m.cachedTokens === null) return null;
  if (m.tokensIn <= 0) return null;
  return Math.min(1, m.cachedTokens / m.tokensIn);
}

/** 累加用量，用于项目级汇总（不含耗时与上下文这类"最后状态"字段）。 */
export function aggregate(rows: readonly RunMetrics[]): {
  turns: number;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number | null;
} {
  let turns = 0;
  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cached: number | null = null;

  for (const row of rows) {
    turns += row.turns;
    steps += row.steps;
    tokensIn += row.tokensIn;
    tokensOut += row.tokensOut;
    if (row.cachedTokens !== null) cached = (cached ?? 0) + row.cachedTokens;
  }
  return { turns, steps, tokensIn, tokensOut, cachedTokens: cached };
}

/** 从Agent行里取 CostLedger 形状（供止损判定复用）。 */
export function toCostLedger(m: RunMetrics): CostLedger {
  return { tokensIn: m.tokensIn, tokensOut: m.tokensOut };
}
