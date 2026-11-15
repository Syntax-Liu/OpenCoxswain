/**
 * RunnerPanel 的判定逻辑测试。
 *
 * `pendingDecisions` 是这几轮最危险的一处：
 * 最初读的是 `executor.blockedReason`（运行时永远为 null），
 * 导致决策卡**一次都不会出现**，而类型系统完全看不出问题。
 *
 * 这里锁住正确语义：待决策来自 `report.needsUser && !ackedAt`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecutorDto, ReportDto } from '../api.js';
import { askingOf, activeOf, finishedOf, pendingDecisions } from '../components/RunnerPanel.js';

let seq = 0;
const report = (over: Partial<ReportDto> = {}): ReportDto => ({
  id: `rpt_${++seq}`,
  projectId: 'prj_1',
  executorId: 'exe_1',
  kind: 'failed',
  body: '未完成',
  needsUser: false,
  at: Date.now(),
  ackedAt: null,
  ...over,
});

const executor = (over: Partial<ExecutorDto> = {}): ExecutorDto =>
  ({
    id: `exe_${++seq}`,
    projectId: 'prj_1',
    sessionId: 's_1',
    label: 'x',
    goal: 'y',
    status: 'running',
    access: 'readwrite',
    writeScope: ['src'],
    summary: null,
    blockedReason: null,
    metrics: null,
    acceptance: null,
    createdAt: Date.now(),
    endedAt: null,
    ...over,
  }) as ExecutorDto;

describe('待决策：来自 report.needsUser，不是 executor.blockedReason', () => {
  it('needsUser 且未 ack → 是待决策', () => {
    const r = report({ needsUser: true, ackedAt: null });
    assert.equal(pendingDecisions([r]).length, 1);
  });

  it('needsUser 但已 ack → 不再是待决策', () => {
    const r = report({ needsUser: true, ackedAt: Date.now() });
    assert.equal(pendingDecisions([r]).length, 0);
  });

  it('needsUser = false → 不是待决策（哪怕没 ack）', () => {
    const r = report({ needsUser: false, ackedAt: null });
    assert.equal(pendingDecisions([r]).length, 0);
  });

  it('**关键回归**：执行者的 blockedReason 有无都不影响判定', () => {
    // 即使 blockedReason 是 null（运行中的正常情况），
    // 只要有 needsUser 的报告，就该出现待决策。
    const e = executor({ status: 'running', blockedReason: null });
    const r = report({ needsUser: true, executorId: e.id });
    assert.equal(pendingDecisions([r]).length, 1);
  });

  it('多条时全部返回', () => {
    const list = [
      report({ needsUser: true }),
      report({ needsUser: false }),
      report({ needsUser: true }),
      report({ needsUser: true, ackedAt: 1 }),
    ];
    assert.equal(pendingDecisions(list).length, 2);
  });
});

describe('Agent 分组', () => {
  it('running 属于活跃', () => {
    const e = executor({ status: 'running' });
    assert.equal(activeOf([e]).length, 1);
    assert.equal(finishedOf([e]).length, 0);
  });

  it('done 属于已结束', () => {
    const e = executor({ status: 'done' });
    assert.equal(finishedOf([e]).length, 1);
    assert.equal(activeOf([e]).length, 0);
  });

  it('failed 留在活跃里（失败要看得见）', () => {
    const e = executor({ status: 'failed' });
    assert.equal(activeOf([e]).length, 1);
  });

  it('cancelled 算已结束', () => {
    const e = executor({ status: 'cancelled' });
    assert.equal(finishedOf([e]).length, 1);
  });

  it('running + blockedReason → 跑道显示 asking，且**仍在活跃里**', () => {
    // laneStatusOf 用 blockedReason 决定跑道的显示状态；
    // 真正的「待决策卡片」由 report.needsUser 决定，两者是不同层。
    //
    // **关键回归**：asking 必须留在 active 里。
    // 曾经 activeOf 只算 running/failed，而 asking 又不属于 decisions，
    // 结果带 blockedReason 的 Agent 三处都不渲染，直接从界面上消失。
    const e = executor({ status: 'running', blockedReason: '需要确认' });
    assert.equal(askingOf([e]).length, 1);
    assert.equal(activeOf([e]).length, 1, 'asking 的 Agent 必须仍然可见');
    assert.equal(finishedOf([e]).length, 0);
  });

  it('**两者独立**：有 blockedReason 不代表有待决策卡片', () => {
    const e = executor({ status: 'running', blockedReason: '需要确认' });
    // 没有任何 report → 没有待决策
    assert.equal(pendingDecisions([]).length, 0);
    // 有 needsUser 报告才是待决策
    assert.equal(pendingDecisions([report({ needsUser: true, executorId: e.id })]).length, 1);
  });
});
