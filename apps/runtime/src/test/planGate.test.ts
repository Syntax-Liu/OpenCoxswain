/**
 * 方案把关测试。
 *
 * 核心风险：**默认关闭时行为必须与之前完全一致**。
 * 一旦默认开启而方案创建流程还没做完，所有派活都会失败，
 * 产品立刻停摆——这比功能缺失严重得多。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN_GATE,
  parsePlanGate,
  planGateEnabled,
  planGateFor,
} from '../settings/planGate.js';

describe('默认值', () => {
  it('**默认是 on**（方案流程已就位，硬关卡可以开了）', () => {
    assert.equal(DEFAULT_PLAN_GATE.mode, 'on');
  });

  it('默认设置下项目走 on', () => {
    assert.equal(planGateEnabled(DEFAULT_PLAN_GATE, 'prj_any'), true);
  });

  it('但 on 不等于「拦下所有活」——没有方案时仍放行（见集成测试）', () => {
    // 这条只是提醒：on 的语义是"有方案且未批准才拦"，
    // 真正验证在 planGateIntegration.test.ts 里。
    assert.equal(planGateFor(DEFAULT_PLAN_GATE, 'prj_x'), 'on');
  });
});

describe('parsePlanGate：坏数据一律退回默认', () => {
  it('null / undefined', () => {
    assert.equal(parsePlanGate(null).mode, 'on');
    assert.equal(parsePlanGate(undefined).mode, 'on');
  });

  it('未知字符串', () => {
    assert.equal(parsePlanGate('garbage').mode, 'on');
    assert.equal(parsePlanGate({ mode: 'yes' }).mode, 'on');
  });

  it('合法值能读', () => {
    assert.equal(parsePlanGate({ mode: 'on' }).mode, 'on');
    assert.equal(parsePlanGate({ mode: 'off' }).mode, 'off');
  });

  it('项目覆盖里的非法值被丢弃，不污染其他项目', () => {
    const s = parsePlanGate({
      mode: 'off',
      projects: { prj_a: 'on', prj_b: 'nope', prj_c: 123 },
    });
    assert.equal(s.projects?.prj_a, 'on');
    assert.equal(s.projects?.prj_b, undefined);
    assert.equal(s.projects?.prj_c, undefined);
  });

  it('全是非法覆盖时 projects 被清掉', () => {
    const s = parsePlanGate({ mode: 'on', projects: { a: 'bad' } });
    assert.equal(s.projects, undefined);
    assert.equal(s.mode, 'on');
  });
});

describe('按项目取值', () => {
  const s = parsePlanGate({ mode: 'off', projects: { prj_strict: 'on' } });

  it('没覆盖的项目用全局默认', () => {
    assert.equal(planGateFor(s, 'prj_normal'), 'off');
    assert.equal(planGateEnabled(s, 'prj_normal'), false);
  });

  it('覆盖过的项目用覆盖值', () => {
    assert.equal(planGateFor(s, 'prj_strict'), 'on');
    assert.equal(planGateEnabled(s, 'prj_strict'), true);
  });

  it('全局 on + 项目 off 也能表达', () => {
    const t = parsePlanGate({ mode: 'on', projects: { prj_loose: 'off' } });
    assert.equal(planGateEnabled(t, 'prj_other'), true);
    assert.equal(planGateEnabled(t, 'prj_loose'), false);
  });
});
