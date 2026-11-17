/**
 * **Assistant 页和 Agent 页必须完全一致。**
 *
 * ## 用户反馈
 *
 * > 为什么你是踢一脚动一下呢？这两种界面应该是一样的，
 *   为什么 Assistant 界面有分隔线，Agent 就没有呢？
 *
 * ## 那个 bug 是什么
 *
 * 右栏的显示条件里只写了 `assistant`：
 *
 *     const hasRailContent =
 *       state.reports.some(...) ||
 *       (view?.kind === 'assistant' && currentProject !== null);   ← 漏了 executor
 *
 * 在 Agent 页时 `hasRailContent` 为 false → 右栏不渲染 → 分隔线消失。
 *
 * ## 这个文件为什么重写过
 *
 * 旧版本靠正则去 `App.tsx` 里找变量名：
 *
 *     assert.match(app, /const hasRailContent =[\s\S]{0,200}/);
 *     assert.match(m[0], /inProject/);
 *
 * 这类测试**防不住等价重构**（改个名字就红），
 * 也**抓不到真 bug**（只要变量名还在，逻辑错了照样绿）。
 *
 * 现在判断逻辑抽到了 `components/viewScope.ts`，
 * 这里直接测行为：给出条件 → 断言右栏该不该出现。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasRail, isInProject } from '../components/viewScope.js';

const assistant = { kind: 'assistant' } as const;
const executor = { kind: 'executor' } as const;
const settings = { kind: 'settings' } as const;
const project = { id: 'p1' };

describe('**两种项目内页面同等待遇**（这就是当初 bug 的根因）', () => {
  it('Assistant 页算项目内', () => {
    assert.equal(isInProject(project, assistant), true);
  });

  it('**Agent 页也算项目内**——漏了它就是分隔线消失的原因', () => {
    assert.equal(isInProject(project, executor), true);
  });

  it('非项目页面不算', () => {
    assert.equal(isInProject(project, settings), false);
    assert.equal(isInProject(project, null), false);
    assert.equal(isInProject(project, undefined), false);
  });

  it('没有打开项目时，任何页面都不算', () => {
    assert.equal(isInProject(null, assistant), false);
    assert.equal(isInProject(null, executor), false);
  });
});

describe('**右栏在两种页面都出现**', () => {
  it('Assistant 页有右栏', () => {
    assert.equal(hasRail(project, assistant, []), true);
  });

  it('**Agent 页也有右栏**（回归：曾为 false）', () => {
    assert.equal(hasRail(project, executor, []), true);
  });

  it('设置页没有右栏', () => {
    assert.equal(hasRail(project, settings, []), false);
  });
});

describe('**待决策的报告能让右栏出现**，不论在哪个页面', () => {
  const pending = [{ needsUser: true, ackedAt: null }];
  const acked = [{ needsUser: true, ackedAt: 123 }];
  const notNeeded = [{ needsUser: false, ackedAt: null }];

  it('有待决策 → 即使不在项目页也显示', () => {
    assert.equal(hasRail(null, settings, pending), true);
  });

  it('已处理过的报告不再撑起右栏', () => {
    assert.equal(hasRail(null, settings, acked), false);
  });

  it('不需要用户的报告不撑起右栏', () => {
    assert.equal(hasRail(null, settings, notNeeded), false);
  });

  it('没有项目也没报告 → 不显示', () => {
    assert.equal(hasRail(null, null, []), false);
  });
});
