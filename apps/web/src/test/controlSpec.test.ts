/**
 * 控件规范的一致性检查。
 *
 * 这个测试读 styles.css，检查是否符合 `docs/control-spec.md`。
 *
 * ## 为什么用测试守 CSS
 *
 * 这几轮反复验证发现：**改了 CSS 以为生效，实际被别处的规则覆盖**。
 * `.nav-item` 的 height 被后面的同名规则盖掉、
 * `.ghost.small` 的高度来自基础层的 padding……
 *
 * 靠人肉每改一次都抓计算样式不现实。这里把**能静态检查的部分**
 * 固化成测试：一旦有人在别处写回散落的值，测试就挂。
 *
 * 检查不了的（层叠、优先级）仍然要靠抓计算样式。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// 测试编译到 dist-test/test/，CSS 在 src/ 下——用项目根定位，不依赖编译产物结构
const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

/** 取某个选择器的所有声明（合并后的）。 */
function declarationsOf(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [];
  let m;
  while ((m = re.exec(css)) !== null) all.push(m[1]);
  return all.join(';');
}

describe('**字号只有 4 档**', () => {
  it('不允许半像素字号（11.5px / 12.5px 会模糊）', () => {
    assert.doesNotMatch(css, /font-size:\s*\d+\.\d+px/, '半像素字号在任何屏幕上都发虚');
  });

  it('font-size 只允许 token 或 4 个档位值', () => {
    const hardcoded = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    // 正文四档：11/12/13/15（配合 --font-scale）。24 是**展示型大标题**，
    // 只允许用在欢迎页 h1 上——标题要有分量感，不该跟着字号缩放变。
    const allowed = new Set([11, 12, 13, 15, 24]);
    const bad = hardcoded.filter((n) => !allowed.has(n));
    assert.deepEqual(bad, [], `这些字号不在规范内: ${bad.join(',')}px`);

    // 24 只许用在欢迎页标题上
    const bigUses = [...css.matchAll(/([^{}]+)\\{[^}]*font-size:\\s*24px/g)].map((m) =>
      (m[1] ?? '').trim(),
    );
    for (const sel of bigUses) {
      assert.match(sel, /welcome-brand h1/, `24px 只允许用在欢迎页标题，实际: ${sel}`);
    }
  });
});

describe('**圆角只有 3 档**', () => {
  it('border-radius 只用 token 或 0/50%', () => {
    const hardcoded = [...css.matchAll(/border-radius:\s*([^;]+);/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((v) => /^\d/.test(v) || v === '50%');
    const allowed = new Set(['0', '50%']);
    const bad = hardcoded.filter((v) => !allowed.has(v) && !v.startsWith('var('));
    assert.deepEqual(bad, [], `这些圆角不在规范内: ${bad.join(', ')}`);
  });
});

describe('状态栏', () => {
  it('**高度固定 22px**（不随内容跳动）', () => {
    const d = declarationsOf('.status-bar');
    assert.match(d, /height:\s*var\(--h-sm\)/, '状态栏高度应该用 --h-sm');
  });

  it('padding 用 4px 网格值', () => {
    const d = declarationsOf('.status-bar');
    assert.match(d, /padding:\s*0 var\(--g-3\)/);
  });
});

describe('消息气泡', () => {
  it('**最大宽度 70%**（再宽一行读不完）', () => {
    const d = declarationsOf('.message.user .bubble');
    assert.match(d, /max-width:\s*70%/);
  });

  it('圆角用 token 不用散落值', () => {
    const d = declarationsOf('.message.user .bubble');
    assert.match(d, /border-radius:\s*var\(--r-md\)/);
    assert.doesNotMatch(d, /border-radius:\s*12px/);
  });
});

describe('焦点可见性', () => {
  it('**有 :focus-visible 规则**（键盘用户要能看到焦点）', () => {
    assert.match(css, /:focus-visible/, '没有 focus-visible 等于键盘用户看不到焦点');
  });

  it('鼠标点击不显示焦点环', () => {
    assert.match(css, /button:focus:not\(:focus-visible\)/);
  });
});

describe('禁用状态只有一套', () => {
  it('**button:disabled 不许重复定义不同透明度**', () => {
    const re = /button:disabled\s*\{([^}]*)\}/g;
    const opacities = [...css.matchAll(re)]
      .map((m) => /opacity:\s*([\d.]+)/.exec(m[1] ?? '')?.[1])
      .filter(Boolean);
    const unique = new Set(opacities);
    assert.ok(unique.size <= 1, `禁用的透明度有 ${unique.size} 种: ${[...unique].join(', ')}`);
  });
});

describe('基础按钮层', () => {
  it('**高度用 token**（子类按需覆盖，但默认要一致）', () => {
    const d = declarationsOf('button');
    assert.match(d, /height:\s*var\(--h-md\)/);
  });
});

describe('**侧栏与设置页必须左对齐**', () => {
  // 踩过两次：`.nav-item` 有 `display: flex` + `text-align: left`，
  // 但漏了 `justify-content`，flex 子项就被按钮默认值居中，
  // 于是 Supervisor / 添加项目 比「新会话」缩进一大截。
  // `text-align` 对 flex 子项无效——这是个很容易漏的点。
  const flexLeftRules = [
    '.nav-item',
    '.thread-item',
    '.settings-nav-item',
    '.new-session',
  ];

  for (const sel of flexLeftRules) {
    it(`${sel} 有 justify-content: flex-start`, () => {
      const re = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`, 'g');
      let found = false;
      let m;
      while ((m = re.exec(css)) !== null) {
        const body = m[1] ?? '';
        if (!body.includes('display: flex')) continue;
        found = true;
        assert.match(body, /justify-content:\s*flex-start/, `${sel} 缺 justify-content: flex-start`);
      }
      assert.ok(found, `找不到 ${sel} 的 flex 规则`);
    });
  }
});

describe('**模板面板是浮层，不挤进工具栏**', () => {
  it('position: absolute（不是普通 flex 子项）', () => {
    // 之前它是 .composer-bar 里的普通子项，行高 22px 却有几像素高，
    // 直接盖住输入框——用户截图"用模板这一块完全重叠"就是这个。
    const m = /\.template-picker\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '找不到 .template-picker');
    assert.match(m[1] ?? '', /position:\s*absolute/);
  });

  it('浮在输入框上方', () => {
    const m = /\.template-picker\s*\{([^}]*)\}/.exec(css);
    assert.match(m?.[1] ?? '', /bottom:\s*calc\(100%/);
  });

  it('父级 .composer-box 有 position: relative', () => {
    assert.match(css, /\.composer-box\s*\{[^}]*position:\s*relative/);
  });
});
describe('**滚动条符合规范**', () => {
  it('宽度用令牌，不写死', () => {
    const m = /::-webkit-scrollbar\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, '找不到 ::-webkit-scrollbar');
    assert.match(m[1] ?? '', /width:\s*var\(--scrollbar-width\)/);
    assert.doesNotMatch(m[1] ?? '', /width:\s*\d+px/, '不该写死像素宽度');
  });

  it('thumb 有圆角（方角在暗色背景上很扎眼）', () => {
    const m = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css);
    assert.match(m?.[1] ?? '', /border-radius:/);
  });

  it('thumb 颜色走令牌，不写死十六进制', () => {
    const m = /::-webkit-scrollbar-thumb\s*\{([^}]*)\}/.exec(css);
    assert.doesNotMatch(m?.[1] ?? '', /background:\s*#[0-9a-f]{3,6}/i, '颜色不该写死');
  });

  it('**不许同时用 scrollbar-width 和 ::-webkit-scrollbar**', () => {
    // 踩过：`.sidebar, .workspace-tree { scrollbar-width: thin }` 让
    // `.workspace-tree::-webkit-scrollbar { width: 5px }` 完全失效，
    // 侧栏滚动条一直是 10px。
    // 原因：设置了标准 scrollbar-width 后，Chromium 会忽略 webkit 伪元素的宽度。
    const hits = css.match(/^\s*scrollbar-width:\s*(?!auto)[\w-]+;/gm) ?? [];
    assert.deepEqual(hits, [], `不该设置 scrollbar-width（会和 webkit 伪元素冲突）: ${hits.join(' ')}`);
  });

  it('侧栏列表用更细的档位', () => {
    assert.match(css, /\.workspace-tree::-webkit-scrollbar/);
    const m = /\.workspace-tree::-webkit-scrollbar[^{]*\{([^}]*)\}/.exec(css);
    assert.match(m?.[1] ?? '', /var\(--scrollbar-width-thin\)/);
  });
});
describe('**消息气泡的规则不许重复**', () => {
  // 踩过：`.message.assistant .bubble` 同时有 5 条规则互相覆盖，
  // 改哪一条都可能被后面的盖掉。排查花了很久。
  const selectors = [
    '.message.assistant .bubble',
    '.message.user .bubble',
    '.message.assistant',
    '.message.user',
  ];

  for (const sel of selectors) {
    it(`${sel} 只有一条规则`, () => {
      const re = new RegExp(`^\\${sel}\\s*\\{`, 'gm');
      const count = (css.match(re) ?? []).length;
      assert.ok(count <= 1, `${sel} 有 ${count} 条规则，会互相覆盖`);
    });
  }

  it('Assistant 气泡有左侧边界（不是完全透明）', () => {
    const m = /^\.message\.assistant \.bubble\s*\{([^}]*)\}/m.exec(css);
    assert.ok(m, '找不到规则');
    assert.match(m[1] ?? '', /border-left:/, '缺少左侧竖线，会变成"旁白"');
  });

  it('**用户气泡没有左侧竖线**（琥珀是"需要操作"的语义色）', () => {
    const m = /^\.message\.user \.bubble\s*\{([^}]*)\}/m.exec(css);
    assert.ok(m, '找不到规则');
    assert.match(m[1] ?? '', /border-left:\s*none/, '用户说的话不是待办，不该有竖线');
  });
});

describe('**决策面板的操作按钮悬停才显示**', () => {
  it('默认 opacity: 0', () => {
    const m = /^\.decision-actions\s*\{([^}]*)\}/m.exec(css);
    assert.ok(m, '找不到 .decision-actions');
    assert.match(m[1] ?? '', /opacity:\s*0/, '8 个按钮常驻会占掉半个面板');
  });

  it('悬停和键盘聚焦时都显示', () => {
    assert.match(css, /\.decision-item:hover\s+\.decision-actions/);
    assert.match(css, /\.decision-item:focus-within\s+\.decision-actions/);
  });
});
describe('**决策面板在右栏，不在顶部**', () => {
  // 用户原话：
  // > 决策面板不要常驻在顶上，应该在右边侧边栏打开，就像 DSH 这样
  // > 放在顶上导致下方对话很扁，看不全内容
  //
  // 顶部面板占垂直空间（实测 26% → 展开 32vh，消息区被压到 370px）；
  // 右栏占宽度，对话区高度完全恢复。
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

  it('**DecisionPanel 渲染在 RightRail 里**', () => {
    // 找 RightRail 块里的内容
    const railStart = app.indexOf('<RightRail');
    assert.ok(railStart > 0, '找不到 <RightRail>');
    // RightRail 有子元素，结束在带缩进的那一行
    const railEnd = app.lastIndexOf(' />');
    assert.ok(railEnd > railStart, '找不到 RightRail 结束标记');
    const railBlock = app.slice(railStart, railEnd);
    assert.match(railBlock, /<DecisionPanel/, 'DecisionPanel 应该在 RightRail 的 decisions 里');
  });

  it('**DecisionPanel 不在 main 的垂直流里**', () => {
    const mainStart = app.indexOf('<main className="main">');
    const mainEnd = app.indexOf('</main>');
    assert.ok(mainStart > 0 && mainEnd > mainStart);
    const mainBlock = app.slice(mainStart, mainEnd);
    assert.doesNotMatch(mainBlock, /<DecisionPanel/, 'DecisionPanel 不该留在 main 里');
  });

  it('右栏宽度可折叠', () => {
    assert.match(app, /railCollapsed/);
    assert.match(app, /railWidth/);
  });
});

describe('右栏样式', () => {
  it('.rail 有左边框，和主区分开', () => {
    const m = /^\.rail \{([^}]*)\}/m.exec(css);
    assert.ok(m, '找不到 .rail');
    assert.match(m[1] ?? '', /border-left:/);
  });

  it('右栏里的决策面板**不再限高**（右栏自己会滚）', () => {
    const m = /\.rail \.decision-panel \{([^}]*)\}/.exec(css);
    assert.ok(m, '找不到 .rail .decision-panel');
    assert.match(m[1] ?? '', /max-height:\s*none/);
  });

  it('右栏里隐藏面板自带标题（和分区标题重复）', () => {
    assert.match(css, /\.rail \.decision-head\s*\{[^}]*display:\s*none/);
  });

  it('决策条数徽章用"需要操作"的琥珀语义色', () => {
    const m = /^\.rail-badge \{([^}]*)\}/m.exec(css);
    assert.match(m?.[1] ?? '', /background:\s*var\(--color-action\)/);
  });
});

describe('**右栏关掉后还能重新打开**', () => {
  // 用户反馈：「目前关闭之后就不知道在哪里打开了，参考 DSH 吧，
  // 图二的右上角最右边的那个按钮，就是展开侧边栏」
  //
  // 原来右栏只能从内部的 ✕ 关掉，关掉后没有任何入口再打开。
  // DSH 的做法：对话标题行最右边放一个**常驻**按钮。
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const conv = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');

  it('Conversation 有 railOpen / onToggleRail', () => {
    assert.match(conv, /railOpen\?:/);
    assert.match(conv, /onToggleRail\?:/);
  });

  it('开关按钮渲染在 header-side 里', () => {
    const idx = conv.indexOf('className="header-side"');
    assert.ok(idx > 0, '找不到 header-side');
    const block = conv.slice(idx, idx + 800);
    assert.match(block, /rail-toggle/, '开关应该在标题行右侧');
  });

  it('**开关的状态和右栏联动**', () => {
    assert.match(app, /railOpen=\{[^}]*railCollapsed/);
    assert.match(app, /onToggleRail=\{\(\)\s*=>\s*setRailCollapsed/);
  });

  it('展开时按钮高亮', () => {
    assert.match(conv, /rail-toggle\$\{[^}]*active/);
  });

  it('按钮有 aria-pressed 和 title（可访问）', () => {
    const idx = conv.indexOf('rail-toggle');
    const block = conv.slice(idx, idx + 400);
    assert.match(block, /aria-pressed=/, '缺少 aria-pressed');
    assert.match(block, /title=/, '缺少 title');
  });

  it('收起时整块隐藏（不留 1px 边框）', () => {
    assert.match(app, /rail-slot/);
    const m = /className="rail-slot"[^>]*style=\{\{[^}]*display:\s*railCollapsed\s*\?\s*'none'/.exec(app);
    assert.ok(m, '收起时应该 display: none，只设宽度 0 会留下左边框');
  });
});
describe('**不许再用字符图标**', () => {
  // 字符图标（⊕ ◎ ⊞ ◫ ◈ ⚿ ◇ ⚙ ⇄ ＋ ↑ ✕ ▾）在不同字体下
  // 粗细/大小/基线都不一致，一排里对不齐。全部改成 SVG。
  const components = [
    'Sidebar.tsx',
    'Conversation.tsx',
    'RightRail.tsx',
    'SettingsPage.tsx',
    'UpdateBanner.tsx',
    'icons.tsx',
  ];

  it('这些文件里没有字符图标', () => {
    // 常见被当图标用的符号区段。**排除 2018-201D（引号）和 2192（→，文字里常用）**
    const iconChars = /[\u2190-\u2191\u2193-\u21FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF]/g;
    const offenders: string[] = [];

    for (const name of components) {
      const text = readFileSync(new URL(`../../src/components/${name}`, import.meta.url), 'utf8');
      // 去掉注释和字符串字面量里的说明文字，只查 JSX 里直接渲染的内容
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/'[^'\n]*'/g, "''")
        .replace(/"[^"\n]*"/g, '""')
        .replace(/`[^`]*`/g, '``');
      const hits = stripped.match(iconChars) ?? [];
      // SettingsPage 的「← 返回应用」是**按钮文字**，不是图标，允许
      const allowed = name === 'SettingsPage.tsx' ? ['\u2190'] : [];
      const bad = hits.filter((h) => !allowed.includes(h));
      if (bad.length > 0) offenders.push(`${name}: ${[...new Set(bad)].join(' ')}`);
    }

    assert.deepEqual(offenders, [], `还有字符图标：\n${offenders.join('\n')}`);
  });

  it('图标统一规格：16 视口 / stroke 1.5 / 线帽圆', () => {
    const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');
    assert.match(icons, /viewBox: '0 0 16 16'/);
    assert.match(icons, /strokeWidth: 1\.5/);
    assert.match(icons, /strokeLinecap: 'round'/);
    assert.match(icons, /strokeLinejoin: 'round'/);
  });

  it('图标颜色继承 currentColor', () => {
    const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');
    assert.match(icons, /stroke: 'currentColor'/);
  });

  it('图标对读屏器隐藏', () => {
    const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');
    assert.match(icons, /'aria-hidden': true/);
  });
});
describe('**「新会话」和「添加项目」不再重复**', () => {
  // 用户指出：这两个作用完全一样——两处都绑同一个 onOpenProject，
  // 点了都是弹"打开项目"对话框。
  //
  // DSH 的分工：新建/打开项目不再是顶部导航项，
  // 而是新会话输入框旁边的一个选择动作（📁 项目名 ▾）。
  const sidebar = readFileSync(new URL('../../src/components/Sidebar.tsx', import.meta.url), 'utf8');
  const conv = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

  it('**侧栏里没有「添加项目」按钮了**', () => {
    // 注释里提到过这个词（说明移除了），要排除注释再查
    const code = sidebar.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /添加项目/, '侧栏不该再有"添加项目"按钮');
  });

  it('侧栏就两个导航项：新会话 + Supervisor', () => {
    // 两个都用 nav-item（结构完全一样），只有图标和文字不同。
    assert.match(sidebar, /onClick=\{props\.onNewSession\}/, '缺新会话');
    assert.match(sidebar, /nav-item\$\{props\.view\.kind === 'global'/, '缺 Supervisor');
  });

  it('**项目选择器在输入区**', () => {
    assert.match(conv, /projectPicker/, 'Conversation 要接收 projectPicker');
    assert.match(conv, /composer-picker-row/, '要渲染在选择器行里');
  });

  it('App 把 ProjectPicker 传给 Conversation', () => {
    assert.match(app, /projectPicker=\{/);
    assert.match(app, /<ProjectPicker/);
  });

  it('选择器里有"打开或新建项目"的入口', () => {
    const picker = readFileSync(new URL('../../src/components/ProjectPicker.tsx', import.meta.url), 'utf8');
    assert.match(picker, /打开或新建项目/);
  });
});

describe('Supervisor 图标和图标库风格统一', () => {
  const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');

  it('**不再是"圆 + 四向射线"**（那看起来像靶心）', () => {
    const m = /export function IconSupervisor[\s\S]*?\n\}/.exec(icons);
    assert.ok(m, '找不到 IconSupervisor');
    assert.doesNotMatch(m[0], /M8 1\.5v1\.5M8 13v1\.5/, '还是旧的准星样式');
  });

  it('用中心节点 + 连线表达"统筹调度"', () => {
    const m = /export function IconSupervisor[\s\S]*?\n\}/.exec(icons);
    const body = m?.[0] ?? '';
    const circles = (body.match(/<circle/g) ?? []).length;
    assert.ok(circles >= 3, `应该有中心 + 外围共 4 个圆，实际 ${circles}`);
    // 坐标在 v0.92 整体下移 1.62 让图形居中，所以从 M8 7.62 起
    assert.match(body, /<path d="M8 7/, '缺少连线');
  });
});
