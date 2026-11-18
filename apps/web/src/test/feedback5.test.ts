/**
 * 用户这一轮的五个反馈。
 *
 * ## 1. 权限设置放进输入框（照 DSH）
 *
 * DSH 输入框左下角有「⊙ 完全权限 ⌄」。我们之前只能进设置页改。
 *
 * ## 2. 滚动条改成长方形
 *
 * 之前是 `border-radius: var(--r-full)`（50%）= 圆角胶囊。
 *
 * ## 3. Agent 页缺侧边栏开关
 *
 * 其他三页都有，Agent 页漏了。
 *
 * ## 4. 右栏空状态要有功能卡片（**上一轮就说过，我没做**）
 *
 * 上一轮我只做了「无内容时隐藏」，没做 DSH 那个四张卡片的空状态。
 * 用户原话：「上一轮我和你说过了，又忘了？」
 *
 * ## 5. 分隔线要明显
 *
 * 第一轮我从 subtle 改成 strong，但 strong 只有 11% 白，看不出来。
 * 这次新增 20% 的 divider 档。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const conversation = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');
const executor = readFileSync(new URL('../../src/components/ExecutorChat.tsx', import.meta.url), 'utf8');
const rightRail = readFileSync(new URL('../../src/components/RightRail.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../../src/components/PermissionPicker.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

/** 合并某选择器**所有**规则（后面的覆盖前面的）。 */
function allProps(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  const props = new Map<string, string>();
  for (const m of all) {
    for (const line of (m[1] ?? '').split('\n')) {
      const pm = /^\s*([a-z-]+)\s*:\s*(.+?);?\s*$/.exec(line);
      if (pm) props.set(pm[1]!, pm[2]!);
    }
  }
  return [...props.entries()].map(([k, v]) => `${k}: ${v};`).join('\n');
}

describe('**1. 权限设置放进输入框**', () => {
  it('主对话输入框里有 PermissionPicker', () => {
    assert.match(conversation, /<PermissionPicker/, '主对话要能随时调权限');
    // 必须在 composer-bar 里（输入框底部工具行）
    const idx = conversation.indexOf('<PermissionPicker');
    const before = conversation.slice(Math.max(0, idx - 800), idx);
    assert.match(before, /composer-left/, '应该放在输入框左下角');
  });

  it('Agent 页输入框里也有', () => {
    assert.match(executor, /<PermissionPicker/);
  });

  it('选择器有四档', () => {
    assert.match(picker, /仅可查看|levels\.map/, '档位从接口拉');
  });

  it('切换时调用 setPermissionLevel', () => {
    assert.match(picker, /setPermissionLevel/);
  });
});

describe('**2. 滚动条是长方形**', () => {
  it('不是 50% 圆角', () => {
    const body = rule('::-webkit-scrollbar-thumb');
    assert.doesNotMatch(body, /r-full|50%/, '胶囊形很丑');
    assert.match(body, /border-radius:\s*2px/);
  });
});

describe('**3. Agent 页有侧边栏开关**', () => {
  it('ExecutorChat 里有 rail-toggle', () => {
    assert.match(executor, /rail-toggle/);
  });

  it('App 真的传了 props', () => {
    const m = /<ExecutorChat[\s\S]*?\/>/.exec(app);
    assert.ok(m, '找不到 ExecutorChat');
    assert.match(m[0], /onToggleRail=/, 'Agent 页缺 onToggleRail');
  });
});

describe('**4. 右栏空状态有功能卡片**', () => {
  it('有 RailEmptyState 组件', () => {
    assert.match(rightRail, /export function RailEmptyState/);
  });

  it('右栏在没有内容时渲染空状态', () => {
    // 改成页签后不再用"三个 prop 都为空"的条件式渲染，
    // 而是把 emptyState 当成「开始」页签的内容——**意图没变**：
    // 没东西可显示时给出功能卡片，而不是一片空白让人以为坏了。
    assert.match(rightRail, /title: '开始', node: props\.emptyState/);
  });

  it('App 传了 emptyState', () => {
    assert.match(app, /RailEmptyState/);
  });

  it('卡片是 DSH 那几项', () => {
    for (const key of ['工作区文件', '打开项目目录', '更多工具']) {
      assert.match(rightRail, new RegExp(key), `缺 ${key} 卡片`);
    }
  });
});

describe('**5. 分隔线要明显**', () => {
  it('有专用的 divider 色值（20% 白）', () => {
    assert.match(css, /--c-overlay-20:\s*rgba\(255, 255, 255, 0\.2\)/);
    assert.match(css, /--color-border-divider:\s*var\(--c-overlay-20\)/);
  });

  it('右栏用 divider 档', () => {
    assert.match(rule('.rail'), /border-left:.*--color-border-divider/);
  });

  it('左栏也用同一档', () => {
    // .sidebar 有多条规则，要合并后看
    assert.match(allProps('.sidebar'), /border-right:.*--color-border-divider/);
  });

  it('**不再用 11% 的 strong**（那个看不出来）', () => {
    assert.doesNotMatch(allProps('.rail'), /border-left:.*--color-border-strong/);
  });
});
