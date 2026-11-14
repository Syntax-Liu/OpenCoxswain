/**
 * 侧栏导航项的结构统一 + 新会话空页。
 *
 * 用户原话：
 * > "新会话"放上去有个框，而"Supervisor"没有，要从代码层面完全一模一样
 * > 欢迎页的图标和文字高度不对齐
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sidebar = readFileSync(new URL('../../src/components/Sidebar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const newPage = readFileSync(new URL('../../src/components/NewSession.tsx', import.meta.url), 'utf8');

describe('**两个导航项结构完全一样**', () => {
  // 之前「新会话」在 .sidebar-top 里（自带 padding 10px 12px 6px），
  // 「Supervisor」在 .nav-main 里——盒子位置、内边距都不同，
  // 看起来就有框/没框、缩进也不齐。
  it('「新会话」不再是 new-session 类', () => {
    assert.doesNotMatch(sidebar, /className="new-session"/, '新会话应该用 nav-item');
  });

  it('「新会话」和「Supervisor」都在 nav-main 里', () => {
    const m = /<nav className="nav-main">([\s\S]*?)<\/nav>/.exec(sidebar);
    assert.ok(m, '找不到 nav-main');
    const body = m[1] ?? '';
    assert.match(body, /新会话/, '新会话应该在 nav-main 里');
    assert.match(body, /Supervisor/, 'Supervisor 应该在 nav-main 里');
  });

  it('两者都是 nav-item + nav-icon 图标', () => {
    // 「新会话」的 className 现在带 active 判断，用模板字符串；
    // 所以检查 onClick 而不是 className 的字面形式。
    assert.match(sidebar, /onClick=\{props\.onNewSession\}/, '缺新会话按钮');
    const icons = sidebar.match(/className="nav-icon"/g) ?? [];
    assert.ok(icons.length >= 2, `两个导航项都要有 nav-icon，实际 ${icons.length}`);
  });

  it('不再有 .sidebar-top 包着新会话', () => {
    assert.doesNotMatch(sidebar, /className="sidebar-top"[\s\S]{0,200}新会话/);
  });
});

describe('**欢迎页图标和文字对齐**', () => {
  // align-items: center 对齐的是盒子中心，但 28px 图标和 24px 文字的
  // 重心位置不同——截图里图标明显偏高。
  it('用基线对齐', () => {
    const m = /^\.welcome-brand \{([^}]*)\}/m.exec(css);
    assert.match(m?.[1] ?? '', /align-items:\s*baseline/);
  });

  it('图标有微调偏移', () => {
    // 可能有多条同名规则，取所有含 top 的那条
    const all = [...css.matchAll(/\.welcome-brand svg \{([^}]*)\}/g)].map((m) => m[1] ?? '');
    assert.ok(all.length > 0, '找不到 .welcome-brand svg');
    // top 用相对单位（em），换字号不用重调
  const withTop = all.filter((b) => /top:\s*[\d.]+(px|em)/.test(b));
    assert.ok(withTop.length > 0, '需要微调让视觉中线重合');
  });
});

describe('**「新会话」进空页，不直接开项目**', () => {
  it('View 有 new 类型', () => {
    assert.match(app, /kind: 'new'/);
  });

  it('点新会话设成 new 视图', () => {
    assert.match(app, /onNewSession=\{\(\)\s*=>\s*setView\(\{\s*kind:\s*'new'\s*\}\)/);
  });

  it('渲染 NewSession', () => {
    assert.match(app, /<NewSession/);
  });

  it('空页有项目选择器', () => {
    assert.match(newPage, /<ProjectPicker/);
  });

  it('空页和主对话用同一套输入框结构', () => {
    assert.match(newPage, /className="composer-box"/);
    assert.match(newPage, /className="composer-bar"/);
  });

  it('没选项目时发送只提示，不真发', () => {
    assert.match(newPage, /先在上面选一个项目/);
  });
});

describe('**导航高亮跟着视图走**', () => {
  // 踩过：为了绕开 typecheck，把 new 视图转成了 global 传下去——
  // 结果点「新会话」时高亮的是 Supervisor。
  it('Sidebar 的 view 类型认识 new', () => {
    assert.match(sidebar, /kind: 'new'/, 'Sidebar 的 view 类型要包含 new');
  });

  it('「新会话」有 active 判断', () => {
    const m = /className=\{[^}]*nav-item[^}]*\}/.exec(sidebar);
    assert.ok(m, '找不到新会话的 className');
    // 两个 nav-item 的 className 都要有 active 判断
    const navClasses = [...sidebar.matchAll(/className=\{[^}]*nav-item[^}]*\}/g)].map((x) => x[0]);
    for (const cls of navClasses) {
      assert.match(cls, /active/, `这个 nav-item 没有 active 判断: ${cls}`);
    }
  });

  it('新会话的 active 判断基于 view.kind === new', () => {
    assert.match(sidebar, /props\.view\.kind === 'new' \? ' active' : ''/);
  });

  it('**App 不再把 new 转成 global**', () => {
    assert.doesNotMatch(
      app,
      /view\.kind !== 'new'[\s\S]{0,40}\{ kind: 'global' \}/,
      '不能把 new 转成 global 传下去——那会让 Supervisor 误高亮',
    );
  });
});