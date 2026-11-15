/**
 * 决策卡的渲染契约测试。
 *
 * 只测「给什么 props → 渲染出什么」，不模拟用户输入。
 *
 * 为什么不在 Node 里模拟输入：
 * happy-dom + React 18 的批处理在这种环境下不稳定（受控值更新后，
 * 同步读到的 DOM 与组件状态会不一致），写出来的测试会时过时不过，
 * 反而制造虚假信心。
 *
 * 交互部分由 scripts/verify-decision.mjs 在**真实 Chrome** 里验证
 * （点按钮、填输入框、断言卡片数量变化），那是可信的。
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { ReportDto } from '../api.js';
import { DecisionCard } from '../components/DecisionCard.js';
import { mountPoint, resetBody, win } from './dom.testenv.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const anyWin = win as any;

const report = (over: Partial<ReportDto> = {}): ReportDto => ({
  id: 'rpt_1',
  projectId: 'prj_1',
  executorId: 'exe_1',
  kind: 'failed',
  body: 'Agent 未完成：达到单轮最大轮次 40',
  needsUser: true,
  at: Date.now(),
  ackedAt: null,
  ...over,
});

let container: any;
let root: any;

beforeEach(() => {
  resetBody();
  container = mountPoint();
  root = createRoot(container);
});

function render(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      createElement(DecisionCard, {
        report: report(),
        executorLabel: '诊断编译',
        onAnswer: () => undefined,
        onSeeTrace: () => undefined,
        onDismiss: () => undefined,
        ...props,
      } as any),
    );
  });
}

function buttons(): any[] {
  return [...container.querySelectorAll('button')];
}

function byText(label: string): any {
  return buttons().find((b) => b.textContent?.trim() === label);
}

describe('决策卡：内容', () => {
  it('显示 Agent 名称与完整卡点原因', () => {
    render();
    const text = container.textContent ?? '';
    assert.match(text, /诊断编译/);
    assert.match(text, /达到单轮最大轮次 40/);
  });

  it('有输入框', () => {
    render();
    assert.ok(container.querySelector('textarea'), '缺输入框');
  });

  it('三个动作都在', () => {
    render();
    assert.ok(byText('发送'), '缺发送');
    assert.ok(byText('看它做了什么'), '缺看它做了什么');
    assert.ok(byText('忽略'), '缺忽略');
  });
});

describe('决策卡：初始状态', () => {
  it('**空输入时发送不可点**（防止空回答）', () => {
    render();
    assert.equal(byText('发送')?.disabled, true);
  });

  it('输入框初始为空', () => {
    render();
    assert.equal(container.querySelector('textarea')?.value, '');
  });

  it('卡片带 decision 类（RunnerPanel 靠它算待决策数量）', () => {
    render();
    assert.ok(container.querySelector('.decision'), '缺 .decision 容器');
  });
});

describe('决策卡：回调接线', () => {
  it('点「忽略」触发 onDismiss', () => {
    let dismissed = 0;
    render({ onDismiss: () => (dismissed += 1) });
    act(() => byText('忽略')!.click());
    assert.equal(dismissed, 1);
  });

  it('点「看它做了什么」触发 onSeeTrace', () => {
    let seen = 0;
    render({ onSeeTrace: () => (seen += 1) });
    act(() => byText('看它做了什么')!.click());
    assert.equal(seen, 1);
  });

  it('「忽略」不会误触发 onSeeTrace', () => {
    let seen = 0;
    render({ onSeeTrace: () => (seen += 1) });
    act(() => byText('忽略')!.click());
    assert.equal(seen, 0);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
