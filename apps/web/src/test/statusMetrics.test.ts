/**
 * 状态栏指标。
 *
 * 核心约束：**每个数字必须有可见标签和口径说明**。
 *
 * 用户和第三方分析都指出过：原来一排数字互相打架、没单位、没口径，
 * 用户读不出任何结论，也不知道哪个能动作。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildStatus, compactNumber, summarizeStatus } from '../components/statusMetrics.js';

const base = {
  turns: 225,
  steps: 319,
  tokensPerSecond: '173',
  totalTokens: '2.20M',
  cacheHit: '91%',
  contextRatio: 0.39,
  contextUsed: '37.4k',
  contextLimit: '96.0k',
};

describe('**每个指标都有标签**', () => {
  it('没有空标签（只有一个图标等于没标签）', () => {
    const groups = buildStatus(base);
    for (const g of groups) {
      for (const m of g.metrics) {
        assert.ok(m.label.length > 0, `${m.id} 没有标签`);
      }
    }
  });

  it('**每个指标都有口径说明**', () => {
    const groups = buildStatus(base);
    for (const g of groups) {
      for (const m of g.metrics) {
        assert.ok(m.detail.length > 10, `${m.id} 缺少口径说明`);
      }
    }
  });

  it('轮次和步数分开，不混成一个"轮·步"', () => {
    const [work] = buildStatus(base);
    assert.equal(work?.metrics.length, 2);
    assert.equal(work?.metrics[0]?.label, '轮次');
    assert.equal(work?.metrics[1]?.label, '步数');
  });
});

describe('分组', () => {
  it('三组：工作量 / 性能 / 上下文', () => {
    const groups = buildStatus(base);
    assert.deepEqual(
      groups.map((g) => g.id),
      ['work', 'perf', 'context'],
    );
  });

  it('**上下文那项有明确的标签**（原来只有一个没有说明的进度条和 39%）', () => {
    const ctx = buildStatus(base).find((g) => g.id === 'context');
    assert.equal(ctx?.metrics[0]?.label, '上下文');
    assert.equal(ctx?.metrics[0]?.value, '39%');
  });
});

describe('**调试类指标默认不显示**', () => {
  it('缓存命中默认不出现（用户看了无法行动）', () => {
    const perf = buildStatus(base).find((g) => g.id === 'perf');
    assert.ok(!perf?.metrics.some((m) => m.id === 'cache'));
  });

  it('显式要求时才出现', () => {
    const perf = buildStatus({ ...base, showDebug: true }).find((g) => g.id === 'perf');
    assert.ok(perf?.metrics.some((m) => m.id === 'cache'));
  });
});

describe('没有值时不显示', () => {
  it('**会话还没跑完时没有速度**，不该显示 "— tok/s"', () => {
    const perf = buildStatus({ ...base, tokensPerSecond: '—' }).find((g) => g.id === 'perf');
    assert.ok(!perf?.metrics.some((m) => m.id === 'speed'));
  });

  it('速度有值时显示', () => {
    const perf = buildStatus(base).find((g) => g.id === 'perf');
    assert.ok(perf?.metrics.some((m) => m.id === 'speed'));
  });
});

describe('数字压缩', () => {
  it('小数字原样', () => {
    assert.equal(compactNumber(42), '42');
    assert.equal(compactNumber(999), '999');
  });

  it('千位 → k', () => {
    assert.equal(compactNumber(1200), '1.2k');
    assert.equal(compactNumber(37400), '37k');
  });

  it('百万位 → M', () => {
    assert.equal(compactNumber(2_196_000), '2.2M');
    assert.equal(compactNumber(12_000_000), '12M');
  });

  it('非法值给占位符', () => {
    assert.equal(compactNumber(NaN), '—');
  });
});

describe('一行摘要', () => {
  it('拼成可读的句子', () => {
    const text = summarizeStatus(buildStatus(base));
    assert.match(text, /轮次 225/);
    assert.match(text, /上下文 39%/);
  });
});
