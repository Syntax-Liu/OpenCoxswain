/**
 * 四个用户反馈的回归测试。
 *
 * ## 1. 移除项目显示成"出错了"
 *
 * `setError(result.message)` —— `result.message` 是**成功文案**，
 * 却塞进了错误通道，于是显示成红色「出错了 / 需要你」卡片。
 *
 * ## 2. 图标"偏上"
 *
 * 改了三次都没好，因为一直在调**位置**。真正的原因是**图标太小**：
 *
 *     新会话      图形 12.5px / 文字 21px = 60%
 *     Supervisor  图形 10.8px / 文字 21px = 51%
 *
 * 中线完全重合（0px），但小图形在大字旁边视觉重心往左上飘。
 * 解法是把图标从 16px 放大到 20px（占比提到 74% / 64%）。
 *
 * ## 3+4. 右栏
 *
 * 新会话/Supervisor 缺展开按钮；无内容时仍占位。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const css = allCss;
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const sidebar = readFileSync(new URL('../../src/components/Sidebar.tsx', import.meta.url), 'utf8');
const newSession = readFileSync(new URL('../../src/components/NewSession.tsx', import.meta.url), 'utf8');
const globalAssistant = readFileSync(new URL('../../src/components/GlobalAssistant.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**移除项目不能显示成错误**', () => {
  it('成功文案走 notice 而不是 error', () => {
    assert.match(app, /setNotice\(result\.message\)/, '成功提示不该进 setError');
  });

  it('有独立的 notice 通道', () => {
    assert.match(app, /const \[notice, setNotice\]/);
    assert.match(app, /notice-card/);
  });

  it('notice 会自动消失（错误不会）', () => {
    assert.match(app, /setTimeout\(\(\) => setNotice\(null\), 4000\)/);
  });

  it('notice 用绿色左边框，和红色错误卡片区分', () => {
    assert.match(rule('.notice-card'), /border-left:.*--color-success/);
  });
});

describe('**图标要够大，视觉重量才和文字匹配**', () => {
  it('导航图标 20px（不是 16px）', () => {
    assert.match(sidebar, /<IconNewChat size=\{20\}/);
    assert.match(sidebar, /<IconSupervisor size=\{20\}/);
  });

  it('.nav-icon 尺寸同步为 20', () => {
    const body = rule('.nav-icon');
    assert.match(body, /width:\s*20px/);
    assert.match(body, /height:\s*20px/);
  });

  it('**注释里记录了为什么是 20**', () => {
    // 防止以后有人"优化"回 16px
    assert.match(css, /51%~60%|视觉重心/, '要留下原因');
  });
});

describe('**右栏：新会话和 Supervisor 也有展开收起**', () => {
  it('NewSession 有 rail-toggle', () => {
    assert.match(newSession, /rail-toggle/);
    assert.match(newSession, /onToggleRail/);
  });

  it('GlobalAssistant 有 rail-toggle', () => {
    assert.match(globalAssistant, /rail-toggle/);
    assert.match(globalAssistant, /onToggleRail/);
  });

  it('**App 真的给这两页传了 props**', () => {
    // 踩过：组件里有渲染代码，但 App 没传 props，按钮永远不出现
    const nsIdx = app.indexOf('<NewSession');
    const nsBlock = app.slice(nsIdx, nsIdx + 400);
    assert.match(nsBlock, /onToggleRail=/, 'NewSession 缺 onToggleRail');
    assert.match(nsBlock, /railOpen=/, 'NewSession 缺 railOpen');

    const gaIdx = app.indexOf('<GlobalAssistant');
    const gaBlock = app.slice(gaIdx, gaIdx + 400);
    assert.match(gaBlock, /onToggleRail=/, 'GlobalAssistant 缺 onToggleRail');
    assert.match(gaBlock, /railOpen=/, 'GlobalAssistant 缺 railOpen');
  });
});

describe('**右栏：分隔线明显 + 无内容不占位**', () => {
  it('分隔线用 divider 档（20% 白；strong 只有 11%，看不出来）', () => {
    const body = rule('.rail');
    assert.match(body, /border-left:\s*0\.5px solid var\(--color-border-divider\)/);
  });

  it('无内容时整块不渲染', () => {
    assert.match(app, /railCollapsed \|\| !hasRailContent/);
  });

  it('hasRailContent 的定义在各页面之间', () => {
    // 判断逻辑已抽到 components/viewScope.ts，这里守的是"App 用的是它"。
    // 具体行为（哪些页面算项目内、报告怎么撑起右栏）由 pageParity.test.ts 测。
    assert.match(app, /hasRailContent = hasRail\(/, 'App 应调用统一的 hasRail 判断');
  });
});
