/**
 * 运行指标的展示格式化。
 *
 * 一条原则：**没数据就显示"—"，不要显示 0**。
 * "缓存命中率 0%" 和 "模型没有报告缓存" 是两件完全不同的事，
 * 混在一起会让用户误以为缓存完全没生效。
 */
import type { RunMetricsDto } from './api.js';

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest}s`;
}

/** token 吞吐（输出 token / 秒）。 */
export function formatRate(tokensOut: number, durationMs: number): string {
  if (durationMs <= 0 || tokensOut <= 0) return '—';
  const rate = tokensOut / (durationMs / 1000);
  return `${rate.toFixed(0)} tok/s`;
}

/** 缓存命中率；模型未报告时返回 null。 */
export function cacheHitRate(metrics: RunMetricsDto): number | null {
  if (metrics.cachedTokens === null) return null;
  if (metrics.tokensIn <= 0) return null;
  return Math.min(1, metrics.cachedTokens / metrics.tokensIn);
}

export function formatPercent(value: number | null): string {
  if (value === null) return '未报告';
  return `${(value * 100).toFixed(1)}%`;
}

/** 一个 Agent的一行摘要：`3 轮 · 5 步 · 12.3k tok · 245 tok/s`。 */
export function summarize(metrics: RunMetricsDto | undefined): string | null {
  if (!metrics) return null;
  const parts: string[] = [];
  if (metrics.turns > 0) parts.push(`${metrics.turns} 轮`);
  if (metrics.steps > 0) parts.push(`${metrics.steps} 步`);
  const tokens = metrics.tokensIn + metrics.tokensOut;
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
  if (metrics.durationMs > 0) {
    parts.push(formatRate(metrics.tokensOut, metrics.durationMs));
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
