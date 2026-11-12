/**
 * 上下文用量预警测试。
 *
 * 核心约束：**ok 档不该打扰用户**。
 * 每次对话都弹一个"上下文正常"的提示，比不提示更烦人。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTEXT_WINDOW,
  NEAR_LIMIT_RATIO,
  describeContext,
  formatTokens,
  progressBar,
} from '../components/contextUsage.js';

describe('ok 档', () => {
  it('用量低时 level=ok', () => {
    const r = describeContext(1000);
    assert.equal(r.level, 'ok');
  });

  it('**ok 档不产生提示**（不打扰）', () => {
    assert.equal(describeContext(1000).message, null);
  });

  it('刚好在阈值以下仍是 ok', () => {
    const justBelow = CONTEXT_WINDOW * NEAR_LIMIT_RATIO - 1;
    assert.equal(describeContext(justBelow).level, 'ok');
  });
});

describe('near 档', () => {
  it('超过阈值变 near', () => {
    const r = describeContext(CONTEXT_WINDOW * NEAR_LIMIT_RATIO);
    assert.equal(r.level, 'near');
  });

  it('提示里含百分比', () => {
    const r = describeContext(CONTEXT_WINDOW * 0.9);
    assert.match(r.message ?? '', /\d+%/);
  });

  it('**提示说明会怎样、能怎么办**', () => {
    const r = describeContext(CONTEXT_WINDOW * 0.9);
    assert.match(r.message ?? '', /折叠/);
    assert.match(r.message ?? '', /新会话/);
  });
});

describe('compacted 档', () => {
  it('压缩过就升级到 compacted', () => {
    const r = describeContext(1000, { compactionCount: 2 });
    assert.equal(r.level, 'compacted');
  });

  it('**即使当前用量低也提示**（用户需要知道前面为什么没了）', () => {
    const r = describeContext(100, { compactionCount: 1 });
    assert.equal(r.level, 'compacted');
    assert.ok(r.message !== null);
  });

  it('提示里说明压缩了几次', () => {
    const r = describeContext(1000, { compactionCount: 3 });
    assert.match(r.message ?? '', /3 次/);
  });

  it('提示给出减少压缩的办法', () => {
    const r = describeContext(1000, { compactionCount: 1 });
    assert.match(r.message ?? '', /@/);
  });
});

describe('边界与格式化', () => {
  it('负数用量按 0 处理', () => {
    const r = describeContext(-5);
    assert.equal(r.used, 0);
    assert.equal(r.ratio, 0);
  });

  it('超过上限时比例封顶 1', () => {
    assert.equal(describeContext(CONTEXT_WINDOW * 2).ratio, 1);
  });

  it('token 格式化', () => {
    assert.equal(formatTokens(500), '500');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(2_500_000), '2.5M');
  });

  it('进度条长度固定', () => {
    assert.equal(progressBar(0, 8).length, 8);
    assert.equal(progressBar(1, 8).length, 8);
  });

  it('进度条反映比例', () => {
    assert.equal(progressBar(0), '░░░░░░░░');
    assert.equal(progressBar(1), '████████');
    assert.equal(progressBar(0.5), '████░░░░');
  });
});
