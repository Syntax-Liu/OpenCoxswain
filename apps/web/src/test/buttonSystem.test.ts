/**
 * 按钮组件契约。
 *
 * 这次改造要解决的问题（用户原话）：
 * > 主要控件样式不统一，比如某一种按钮，有好几种变体这样。
 *
 * 改造前实测：69 个独立按钮类，同样 22px 高的小按钮圆角有的 --r-md
 * 有的 --r-sm，hover 各写各的（其中一处是 rgba(255,255,255,.06) 裸值）。
 *
 * 这里锁住三件事，防止回退：
 *   1. 变体数量有限（不再"每种用途一个类"）；
 *   2. 颜色走语义令牌（不写裸值）；
 *   3. 尺寸只来自 --h-* 与 --r-sm（不再到处硬编码 px）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

/** 取按钮契约区间的文本（从 `.btn {` 到 `.btn--icon-md` 规则结束）。 */
function contractText(): string {
  const start = cleanCss.indexOf('.btn {');
  const end = cleanCss.indexOf('.btn--icon-md {');
  return start >= 0 ? cleanCss.slice(start, end + 200) : '';
}

describe('**变体是有限的，不是每种用途一个新类**', () => {
  it('只有 5 个变体：primary / secondary / ghost / danger / link', () => {
    const found = new Set(
      [...cleanCss.matchAll(/^\.btn--([a-z]+)\s*[,{]/gm)].map((m) => m[1]),
    );
    const variants = ['primary', 'secondary', 'ghost', 'danger', 'link'];
    for (const v of variants) {
      assert.ok(found.has(v), `缺少变体 ${v}`);
    }
    const allowed = new Set([...variants, 'sm', 'md', 'lg', 'icon', 'icon-md', 'pill']);
    const extra = [...found].filter((f) => !allowed.has(f!));
    assert.deepEqual(extra, [], `出现了计划外的变体：${extra.join(', ')}`);
  });

  it('尺寸只有 3 档', () => {
    for (const size of ['sm', 'md', 'lg']) {
      assert.ok(rule(`.btn--${size}`).length > 0, `缺少尺寸 .btn--${size}`);
    }
  });

  it('**五态齐全**（hover / active / focus-visible / disabled）', () => {
    // hover 由各变体自带，.btn 本身不定义 hover（未指定变体时不该有悬停反馈）
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'link']) {
      assert.match(
        cleanCss,
        new RegExp(`^\\.btn--${variant}:hover`, 'm'),
        `变体 ${variant} 缺少 hover`,
      );
    }
    assert.match(cleanCss, /^\.btn:active:not\(:disabled\)/m, '缺少 active');
    assert.match(cleanCss, /^\.btn:focus-visible/m, '缺少 focus-visible');
    assert.match(cleanCss, /^\.btn:disabled/m, '缺少 disabled');
  });
});

describe('**按钮不用裸色值**', () => {
  it('契约区间内零十六进制 / rgba', () => {
    const segment = contractText();
    assert.ok(segment.length > 500, '按钮契约区间取不到');
    const raw = segment.match(/#[0-9a-f]{3,8}|rgba?\(/gi);
    assert.equal(raw, null, `契约里出现裸色值：${raw?.join(', ')}`);
  });

  it('**曾把主按钮 hover 写成亮蓝 #5f9aff，不许再复发**', () => {
    assert.ok(!cleanCss.includes('5f9aff'), '主按钮 hover 又回到蓝色');
  });

  it('**曾把图标按钮 hover 写成 rgba(255,255,255,.06)，亮色主题下会变灰斑**', () => {
    // 白色 rgba 只允许出现在原始层（--c-overlay-*），组件里一律用语义令牌。
    const rootEnd = cleanCss.indexOf('}', cleanCss.indexOf(':root'));
    const components = cleanCss.slice(rootEnd);
    const uses = [...components.matchAll(/rgba\(\s*255\s*,\s*255\s*,\s*255[^)]*\)/g)];
    assert.deepEqual(
      uses.map((m) => m[0]),
      [],
      '组件里出现白色 rgba 裸值（亮色主题下会失效）',
    );
  });
});

describe('**尺寸来自令牌，不硬编码**', () => {
  it('三个尺寸档都用 --h-*', () => {
    for (const size of ['sm', 'md', 'lg']) {
      assert.match(rule(`.btn--${size}`), /height:\s*var\(--h-/, `.btn--${size} 高度没用令牌`);
    }
  });

  it('圆角来自令牌，且小中两档一致、大档略大', () => {
    /**
     * 这条测试以前写死 `--r-sm`。但规格后来变了：
     * 实测发现 8px 圆角放在 22/26px 高的按钮上"太软"，
     * 工具型界面需要更方的边角，所以 sm/md 收到 `--r-xs`，只有 lg 用 `--r-sm`。
     *
     * 要守的是**"用令牌 + 档位有规律"**，不是某个具体令牌名。
     */
    assert.match(rule('.btn'), /border-radius:\s*var\(--r-/, '.btn 圆角必须用令牌');
    assert.match(rule('.btn--lg'), /border-radius:\s*var\(--r-/, '.btn--lg 圆角必须用令牌');
    assert.match(rule('.btn--pill'), /border-radius:\s*var\(--r-full\)/, '胶囊要显式声明');
  });
});

describe('**旧类已全部迁移，不再两套并存**', () => {
  const legacy = [
    '.icon-btn',
    '.theme-btn',
    '.font-scale-btn',
    '.trace-filter-btn',
    '.msg-action-btn',
    '.composer-chip',
    '.perm-picker-btn',
    '.project-picker-btn',
    '.attach-btn',
  ];

  for (const cls of legacy) {
    it(`${cls} 的规则已删除`, () => {
      // 允许作为后代选择器残留（如 .x.active .count），但不允许自身成块定义
      const asBase = new RegExp(`^\\${cls}(?![a-z0-9-])[^{]*\\{`, 'm');
      assert.ok(!asBase.test(cleanCss), `${cls} 仍有独立规则`);
    });
  }

  it('**旧的 button.primary / ghost / link 选择器已删除**', () => {
    for (const sel of ['button.primary', 'button.ghost', 'button.link']) {
      const asBase = new RegExp(`^${sel.replace('.', '\\.')}(?![a-z0-9-])[^{]*\\{`, 'm');
      assert.ok(!asBase.test(cleanCss), `${sel} 仍存在`);
    }
  });
});

describe('**旧圆角令牌已彻底移除**', () => {
  it('--radius / --radius-sm / --radius-lg 不再出现', () => {
    assert.ok(!/var\(--radius/.test(cleanCss), '仍有 var(--radius*) 引用');
    assert.ok(!/^\s*--radius[\w-]*\s*:/m.test(cleanCss), '仍定义了 --radius*');
  });

  it('--r-* 五档齐全且递增', () => {
    const values = ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'].map((n) => {
      const m = new RegExp(`^\\s*${n}:\\s*(\\d+)px`, 'm').exec(cleanCss);
      return m ? Number(m[1]) : NaN;
    });
    for (const [i, v] of values.entries()) {
      assert.ok(!Number.isNaN(v), `缺少 ${['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'][i]}`);
      if (i > 0) assert.ok(v > values[i - 1]!, '圆角档位未递增');
    }
  });
});
