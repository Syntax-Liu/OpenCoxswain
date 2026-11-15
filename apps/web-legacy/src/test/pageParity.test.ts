/**
 * **Assistant 和 Agent 页必须完全一致。**
 *
 * ## 用户反馈
 *
 * > 为什么你是踢一脚动一下呢？这两种界面应该是一样的，
 *   为什么 Assistant 界面有分隔线，Agent 就没有呢？
 *   我说了要尽可能将类似的控件统一合并，你做了没有呢？
 *
 * ## 根因
 *
 * 我把这两个页面当成两个东西，条件判断里只写了 `assistant`：
 *
 *     const hasRailContent =
 *       state.reports.some(...) ||
 *       (view?.kind === 'assistant' && currentProject !== null);   ← 漏了 executor
 *
 * Agent 页时 `hasRailContent` 为 false → `.rail-slot` 被设成
 * `display: none` → 右栏整个不渲染 → 分隔线自然没有。
 *
 * `decisions` 那边也是同样的写法——Agent 页看不到待决策。
 *
 * ## 修法
 *
 * 定义**一个** `inProject` 判断，两处都用它。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

describe('**项目内页面的判断只有一个**', () => {
  it('有统一的 inProject 定义', () => {
    assert.match(app, /const inProject =/, '要有一个统一判断');
  });

  it('inProject 覆盖 assistant 和 executor 两种', () => {
    const m = /const inProject =[\s\S]{0,200}/.exec(app);
    assert.ok(m, '找不到 inProject');
    assert.match(m[0], /'assistant'/);
    assert.match(m[0], /'executor'/, '**漏了 Agent 页——这就是分隔线消失的原因**');
  });

  it('hasRailContent 用 inProject，不再单独判断 assistant', () => {
    const m = /const hasRailContent =[\s\S]{0,200}/.exec(app);
    assert.ok(m, '找不到 hasRailContent');
    assert.match(m[0], /inProject/, '应该复用统一判断');
    assert.doesNotMatch(m[0], /kind === 'assistant'/, '不能再写死 assistant');
  });

  it('待决策面板也用 inProject', () => {
    // 之前是 view?.kind === 'assistant' && currentProject
    const m = /decisions=\{[\s\S]{0,100}/.exec(app);
    assert.ok(m, '找不到 decisions');
    assert.match(m[0], /inProject/, 'Agent 页也要能看到待决策');
  });
});

describe('右栏在两种页面都渲染', () => {
  it('rail-slot 的条件是 railCollapsed || !hasRailContent', () => {
    assert.match(app, /railCollapsed \|\| !hasRailContent/);
  });

  it('ExecutorChat 有 railOpen / onToggleRail', () => {
    const m = /<ExecutorChat[\s\S]*?\/>/.exec(app);
    assert.ok(m, '找不到 ExecutorChat');
    assert.match(m[0], /railOpen=/);
    assert.match(m[0], /onToggleRail=/);
  });

  it('ExecutorChat 有权限选择器用的 api', () => {
    const m = /<ExecutorChat[\s\S]*?\/>/.exec(app);
    assert.ok(m, '找不到 ExecutorChat');
    assert.match(m[0], /api=\{api\}/);
  });
});
