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
    const allowed = new Set([11, 12, 13, 15]);
    const bad = hardcoded.filter((n) => !allowed.has(n));
    assert.deepEqual(bad, [], `这些字号不在规范内: ${bad.join(',')}px`);
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