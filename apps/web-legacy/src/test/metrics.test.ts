/**
 * 运行指标的展示逻辑测试。
 *
 * 核心原则：**没数据显示"—"，不显示 0**。
 * "缓存命中率 0%" 与 "模型没报告缓存" 是两回事，混起来会误导用户。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cacheHitRate,
  formatDuration,
  formatPercent,
  formatRate,
  formatTokens,
  summarize,
} from '../metrics.js';
import type { RunMetricsDto } from '../api.js';

const metrics = (over: Partial<RunMetricsDto> = {}): RunMetricsDto => ({
  turns: 0,
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  cachedTokens: null,
  durationMs: 0,
  contextTokens: null,
  ...over,
});

describe('token 数量格式化', () => {
  it('按量级换算', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(2_456_789), '2.46M');
  });

  it('null 显示破折号，不是 0', () => {
    assert.equal(formatTokens(null), '—');
    assert.equal(formatTokens(undefined), '—');
    assert.equal(formatTokens(0), '0', '真实的 0 要显示为 0');
  });
});

describe('耗时与吞吐', () => {
  it('耗时按量级显示', () => {
    assert.equal(formatDuration(300), '300ms');
    assert.equal(formatDuration(2500), '2.5s');
    assert.equal(formatDuration(125_000), '2m5s');
    assert.equal(formatDuration(0), '—');
  });

  it('吞吐 = 输出 token / 秒', () => {
    assert.equal(formatRate(1000, 2500), '400 tok/s');
  });

  it('耗时为 0 时吞吐显示破折号（不编数字）', () => {
    assert.equal(formatRate(100, 0), '—');
  });
});

describe('缓存命中率', () => {
  it('有数据时正确计算', () => {
    assert.equal(cacheHitRate(metrics({ tokensIn: 1000, cachedTokens: 850 })), 0.85);
  });

  it('模型未报告时返回 null（关键：不能当 0 处理）', () => {
    assert.equal(cacheHitRate(metrics({ tokensIn: 1000, cachedTokens: null })), null);
    assert.equal(formatPercent(null), '未报告');
  });

  it('真实的 0% 与"未报告"要能区分', () => {
    assert.equal(cacheHitRate(metrics({ tokensIn: 1000, cachedTokens: 0 })), 0);
    assert.equal(formatPercent(0), '0.0%');
    assert.equal(formatPercent(null), '未报告');
  });
});

describe('一行摘要', () => {
  it('组合轮次/步数/token/吞吐', () => {
    const text = summarize(
      metrics({ turns: 3, steps: 5, tokensIn: 8000, tokensOut: 2000, durationMs: 4000 }),
    );
    assert.match(text ?? '', /3 轮/);
    assert.match(text ?? '', /5 步/);
    assert.match(text ?? '', /10\.0k tok/);
    assert.match(text ?? '', /500 tok\/s/);
  });

  it('什么都没有时返回 null（界面显示状态文字）', () => {
    assert.equal(summarize(metrics()), null);
    assert.equal(summarize(undefined), null);
  });
});
