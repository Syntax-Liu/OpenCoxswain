/**
 * 用量止损与运行指标测试。
 *
 * 注意：这里**不测计费**。按用户要求，不估算金额——不同模型单价不同
 * 且随时调整，软件离线无法获取实时价格，估出来的数只会误导人。
 * 只测模型自己报告的真实数字，以及基于这些数字的止损。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  evaluateRunning,
  evaluateSpawn,
  formatTokens,
  parseTokenGuard,
  startOfToday,
  totalTokens,
} from '../cost/budget.js';
import {
  EMPTY_METRICS,
  aggregate,
  cacheHitRate,
  tokensPerSecond,
} from '../cost/metrics.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-guard-'));
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe('用量止损判定', () => {
  it('未设上限时永远 ok', () => {
    const result = evaluateRunning({}, { tokensIn: 9e9, tokensOut: 9e9 }, { tokensIn: 9e9, tokensOut: 9e9 });
    assert.equal(result.status, 'ok');
    assert.equal(result.reasons.length, 0);
  });

  it('单任务超限 → exceeded，并给出可读原因', () => {
    const result = evaluateRunning(
      { perTask: 1000 },
      { tokensIn: 900, tokensOut: 200 }, // 1100 > 1000
      { tokensIn: 900, tokensOut: 200 },
    );
    assert.equal(result.status, 'exceeded');
    assert.match(result.breached ?? '', /本任务 token/);
  });

  it('日上限超限 → exceeded', () => {
    const result = evaluateRunning(
      { perDay: 5000 },
      { tokensIn: 100, tokensOut: 50 },
      { tokensIn: 5000, tokensOut: 100 },
    );
    assert.equal(result.status, 'exceeded');
    assert.match(result.breached ?? '', /今日 token/);
  });

  it('接近上限（≥80%）给 warning，但不硬停', () => {
    const result = evaluateRunning(
      { perTask: 1000 },
      { tokensIn: 800, tokensOut: 50 },
      { tokensIn: 0, tokensOut: 0 },
    );
    assert.equal(result.status, 'warning');
    assert.equal(result.breached, undefined);
  });

  it('派活前只看日上限（单任务还没开始跑）', () => {
    const over = evaluateSpawn({ perTask: 1, perDay: 100 }, { tokensIn: 90, tokensOut: 20 });
    assert.equal(over.status, 'exceeded');

    const fine = evaluateSpawn({ perTask: 1, perDay: 10000 }, { tokensIn: 90, tokensOut: 20 });
    assert.equal(fine.status, 'ok');
  });

  it('格式化成易读单位', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(2_500_000), '2.50M');
  });

  it('解析配置：拒绝负数与非数字', () => {
    assert.deepEqual(parseTokenGuard({ perTask: 1000 }), { perTask: 1000 });
    assert.deepEqual(parseTokenGuard({ perTask: 0 }), {}, '0 视为未设置');
    assert.throws(() => parseTokenGuard({ perTask: -1 }), /非负/);
    assert.throws(() => parseTokenGuard({ perDay: 'abc' }), /非负/);
  });

  it('当日边界在本地零点', () => {
    const noon = new Date(2026, 10, 11, 12, 30).getTime();
    const start = startOfToday(noon);
    const d = new Date(start);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getDate(), 11);
  });
});

describe('运行指标', () => {
  it('吞吐 = 输出 token / 秒', () => {
    const rate = tokensPerSecond({ ...EMPTY_METRICS, tokensOut: 1000, durationMs: 2000 });
    assert.equal(rate, 500);
  });

  it('耗时为 0 时吞吐为 null（不编数字）', () => {
    assert.equal(tokensPerSecond({ ...EMPTY_METRICS, tokensOut: 100, durationMs: 0 }), null);
  });

  it('缓存命中率：没数据时为 null，不是 0', () => {
    assert.equal(cacheHitRate({ ...EMPTY_METRICS, tokensIn: 100, cachedTokens: null }), null);
    assert.equal(cacheHitRate({ ...EMPTY_METRICS, tokensIn: 100, cachedTokens: 60 }), 0.6);
  });

  it('聚合多个 Agent', () => {
    const totals = aggregate([
      { ...EMPTY_METRICS, turns: 2, steps: 1, tokensIn: 100, tokensOut: 50, cachedTokens: 40 },
      { ...EMPTY_METRICS, turns: 3, steps: 2, tokensIn: 200, tokensOut: 80, cachedTokens: null },
    ]);
    assert.equal(totals.turns, 5);
    assert.equal(totals.steps, 3);
    assert.equal(totals.tokensIn, 300);
    assert.equal(totals.cachedTokens, 40, '只有报告了缓存的才累加');
  });
});

// ---------------------------------------------------------------------------
// 端到端：烧 token 的Agent到阈值被停掉
// ---------------------------------------------------------------------------

describe('用量止损真的能停下来', () => {
  it('Agent烧到上限后被中止，且原因写明是止损', async () => {
    const root = await projectDir();
    const store = new MemoryStore();

    // 一个永远在调工具的假模型：每轮烧 800 token，会一直跑下去。
    const burning = new MockLlmClient(
      (request) => {
        if (!isExecutorTurn(request)) return { text: 'ok' };
        return { tool: 'list_dir', args: { path: '.' } };
      },
      { tokensIn: 600, tokensOut: 200 },
    );

    const runtime = new Orchestrator({ store, llm: burning, maxStepsPerExecutor: 100 });
    const { project } = await runtime.openProject({ rootPath: root });

    // 设一个很小的单任务上限
    await store.putProject({ ...project, tokenGuard: { perTask: 100 } });

    await runtime.spawn(project.id, { label: '烧 token 的', goal: '不停读目录', writeScope: ['readonly'] });

    // 等它被停
    const deadline = Date.now() + 8000;
    let row = store.listExecutors({ projectId: project.id })[0];
    while (Date.now() < deadline) {
      row = store.listExecutors({ projectId: project.id })[0];
      if (row && (row.status === 'failed' || row.status === 'done')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.ok(row, '应当有Agent记录');
    assert.equal(row.status, 'failed', '超限应当被中止');
    assert.match(row.blockedReason ?? '', /用量上限中止/);
    assert.ok(row.metrics.turns > 0, '应当记录了轮次');

    // 落了待决策汇报
    const reports = store.listReports({ projectId: project.id, needsUser: true });
    assert.ok(reports.some((r) => r.body.includes('用量上限')), '必须告知用户被止损了');

    await runtime.dispose();
  });

  it('超限后拒绝派出新Agent，并给出可读原因', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const { project } = await runtime.openProject({ rootPath: root });

    await store.putProject({ ...project, tokenGuard: { perDay: 100 } });
    // 伪造今天的用量：塞一条已完成的Agent
    await store.putExecutor({
      id: 'exe_used',
      projectId: project.id,
      sessionId: 'd_used',
      label: '已经跑完的',
      goal: 'g',
      access: 'readonly',
      writeScope: [],
      status: 'done',
      summary: 'ok',
      blockedReason: null,
      metrics: { ...EMPTY_METRICS, tokensIn: 200, tokensOut: 50 },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: Date.now(),
    });

    await assert.rejects(
      () => runtime.spawn(project.id, { label: '新的', goal: 'g', writeScope: ['readonly'] }),
      /已拒绝派活/,
    );

    await runtime.dispose();
  });

  it('没设上限时不会误伤', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: '结论：完成。' })) });
    const { project } = await runtime.openProject({ rootPath: root });

    const result = await runtime.spawn(project.id, { label: '正常任务', goal: 'g', writeScope: ['readonly'] });
    assert.equal(result.admitted, true);

    await runtime.dispose();
  });

  it('totalTokens 把输入输出相加', () => {
    assert.equal(totalTokens({ tokensIn: 100, tokensOut: 25 }), 125);
  });
});
