/**
 * 三层设计令牌。
 *
 * 结构照 DSH（MIT 开源）。从它打包产物里的变量命名可以直接看出来：
 *
 *     --dsw-static-blue-400       原始色板
 *     --dsw-alias-label-primary   语义别名
 *     --dsh-menu-anchor           组件级
 *
 * 我们之前是**一层**：`--accent: #e0a04a` 既是色值又是含义。
 *
 * 核心约束：**只有原始层允许写十六进制颜色。**
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

/** 取 :root 里某个变量定义的整行。 */
function token(name: string): string | null {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
  return m ? (m[1] ?? '').trim() : null;
}

describe('第一层：原始色板', () => {
  it('中性色板存在', () => {
    for (const n of ['--c-neutral-950', '--c-neutral-900', '--c-neutral-300', '--c-neutral-100']) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('琥珀色板存在', () => {
    for (const n of ['--c-amber-600', '--c-amber-500', '--c-amber-400', '--c-amber-300']) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('功能色板存在', () => {
    for (const n of ['--c-green-500', '--c-red-500', '--c-blue-500']) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('**原始层存的是实际色值**', () => {
    assert.match(token('--c-neutral-950') ?? '', /^#[0-9a-f]{6}$/i);
    assert.match(token('--c-amber-400') ?? '', /^#[0-9a-f]{6}$/i);
  });
});

describe('第二层：语义别名', () => {
  it('表面语义齐全', () => {
    for (const n of [
      '--color-surface-canvas',
      '--color-surface-sidebar',
      '--color-surface-sunken',
      '--color-surface-panel',
      '--color-surface-raised',
      '--color-surface-hover',
      '--color-surface-selected',
    ]) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('文字语义齐全', () => {
    for (const n of [
      '--color-label-primary',
      '--color-label-strong',
      '--color-label-secondary',
      '--color-label-tertiary',
    ]) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('状态语义齐全', () => {
    for (const n of [
      '--color-action',
      '--color-success',
      '--color-danger',
      '--color-warn',
      '--color-info',
    ]) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('**语义层只引用原始层，不写字面色值**', () => {
    for (const n of [
      '--color-surface-canvas',
      '--color-label-primary',
      '--color-action',
      '--color-danger',
      '--color-border-subtle',
    ]) {
      const v = token(n) ?? '';
      assert.ok(v.startsWith('var(--c-'), `${n} 应该引用原始层，实际是 ${v}`);
    }
  });
});

describe('**只有原始层出现十六进制颜色**', () => {
  it('旧名全部指向语义层', () => {
    for (const n of [
      '--bg',
      '--bg-sidebar',
      '--bg-panel',
      '--bg-elevated',
      '--bg-input',
      '--border',
      '--text',
      '--text-strong',
      '--text-muted',
      '--text-dim',
      '--accent',
      '--ok',
      '--warn',
      '--danger',
      '--info',
    ]) {
      const v = token(n) ?? '';
      assert.ok(v.startsWith('var(--color-'), `${n} 应该指向语义层，实际是 ${v}`);
    }
  });

  it('**语义层没有残留的十六进制值**', () => {
    // 找出所有 --color-* 的定义，确认都是 var()
    for (const m of css.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)) {
      const name = m[1];
      const value = (m[2] ?? '').trim();
      assert.ok(
        value.startsWith('var(--c-'),
        `${name} 直接写了色值 ${value}，应该引用原始层`,
      );
    }
  });
});

describe('颜色值锁定（防止意外改动）', () => {
  // 这些是原始层的实际值，逐一核对。
  //
  // 用途：改色应当是**有意识的决定**，不能因为重构/批量替换而悄悄变掉。
  // 若确实需要改色（例如对比度不达标），改这里 + 说明理由 + 跑 audit-theme-contrast。
  //
  // 2026-11-14：neutral-500 / neutral-600 / red-500 因 WCAG 对比度不达标
  // （详见 docs/ui-consistency-plan.md §14）做过明度调整。
  //
  // 2026-11-17：neutral-600 再次调整（3.43:1 → 5.10:1）。
  // 它是 --color-label-tertiary，用于标题栏面包屑、侧栏「工作区」、
  // 状态栏「已连接」等元信息。上一轮只修到 3.0，仍低于 AA 的 4.5，
  // 由 `audit-live-contrast` 在真实界面里量出来（暗色 7 处、亮色 8 处）。
  // 亮色侧的同一变量也一并修了（3.46:1 → 5.36:1）。
  // 没提到 7:1 是刻意的：元信息要比正文弱，提太多会破坏主次层级。
  const expected: Record<string, string> = {
    '--c-neutral-950': '#0a0c0f',
    '--c-neutral-900': '#0d1013',
    '--c-neutral-880': '#0e1216',
    '--c-neutral-850': '#11151a',
    '--c-neutral-800': '#171c23',
    '--c-neutral-750': '#1a2028',
    '--c-neutral-700': '#1f262f',
    '--c-neutral-600': '#7d858d', // 对比度修正（3.43:1 → 5.10:1，AA 达标）
    '--c-neutral-500': '#7d858d', // 对比度修正（原 #7a828b，4.40:1 → 4.5）
    '--c-neutral-300': '#c4cbd3',
    '--c-neutral-100': '#e8eaed',
    '--c-amber-600': '#6b4f22',
    '--c-amber-500': '#c98b4b',
    '--c-amber-450': '#e0a04a', // 文字用的琥珀：暗色下与填充色同值
    '--c-amber-400': '#e0a04a',
    '--c-amber-300': '#eab366',
    '--c-green-500': '#5a8f7b',
    '--c-red-500': '#c26c69', // 对比度修正（原 #b85450，3.60:1 → 4.5）
    '--c-blue-500': '#5a7d99',
  };

  for (const [name, hex] of Object.entries(expected)) {
    it(`${name} = ${hex}`, () => {
      assert.equal((token(name) ?? '').toLowerCase(), hex.toLowerCase());
    });
  }
});

describe('**圆角按 DSH 的层级补全**', () => {
  // 实测 DSH：xs=4 sm=8 md=12 lg=16 xl=20 panel=28（6 级）
  // 我们之前只有 3px / 4px 两档，比 DSH 小 3~4 倍——
  // 这是界面看着"生硬"的主要原因。
  it('至少 5 档圆角', () => {
    const sizes = ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'];
    for (const n of sizes) assert.ok(token(n), `缺少 ${n}`);
  });

  it('**档位严格递增**', () => {
    const values = ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl'].map((n) =>
      parseFloat(token(n) ?? '0'),
    );
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i]! > values[i - 1]!, `圆角档位没有递增: ${values.join(',')}`);
    }
  });

  it('最大档不小于 10px（之前最大才 4px，太方）', () => {
    assert.ok(parseFloat(token('--r-xl') ?? '0') >= 10);
  });
});

describe('**动效时长统一成 3 档**', () => {
  it('三档都在', () => {
    for (const n of ['--dur-fast', '--dur-base', '--dur-slow']) {
      assert.ok(token(n), `缺少 ${n}`);
    }
  });

  it('档位递增', () => {
    const v = ['--dur-fast', '--dur-base', '--dur-slow'].map((n) => parseFloat(token(n) ?? '0'));
    assert.ok(v[1]! > v[0]!);
    assert.ok(v[2]! > v[1]!);
  });

  it('**没有硬编码的 transition 时长**', () => {
    // 之前散落 6 处 0.12s / 0.1s，没有统一节奏
    const hard = css.match(/transition:[^;]*\d+\.\d+s/g) ?? [];
    assert.equal(hard.length, 0, `还有硬编码时长: ${hard.slice(0, 3).join(' | ')}`);
  });
});

describe('中性色阶足够密', () => {
  it('**暗色端至少 8 档**（DSH 有 22 级，我们原来只有 4 级）', () => {
    const dark = css.match(/--c-neutral-(?:1000|950|900|880|850|820|800|780|750|700|650):/g) ?? [];
    assert.ok(dark.length >= 8, `暗色档位只有 ${dark.length} 个`);
  });

  it('新增档位不破坏原有色值', () => {
    assert.equal(token('--c-neutral-950'), '#0a0c0f');
    assert.equal(token('--c-neutral-850'), '#11151a');
    assert.equal(token('--c-neutral-800'), '#171c23');
  });
});
describe('**间距尺度覆盖实际用到的值**', () => {
  // 原来只有 4/8/12/16/24 五档，但 CSS 里实际用了 7 种值
  // （2/4/6/7/8/10/12px），共 86 处裸 px。
  it('包含 2px 档（图标与文字）', () => {
    assert.equal(token('--g-05'), '2px');
  });

  it('包含 6px 档（芯片内边距）', () => {
    assert.equal(token('--g-15'), '6px');
  });

  it('包含 10px 档（按钮水平内边距）', () => {
    assert.equal(token('--g-25'), '10px');
  });

  it('尺度严格递增', () => {
    const levels = ['--g-05', '--g-1', '--g-15', '--g-2', '--g-25', '--g-3', '--g-4', '--g-5', '--g-6'];
    const values = levels.map((n) => parseFloat(token(n) ?? '0'));
    for (let i = 1; i < values.length; i += 1) {
      assert.ok(values[i]! > values[i - 1]!, `间距没有递增: ${values.join(',')}`);
    }
  });
});

describe('组件级令牌', () => {
  it('侧栏令牌齐全', () => {
    assert.ok(token('--sidebar-width'));
    assert.ok(token('--sidebar-inline-pad'));
    assert.ok(token('--sidebar-row-pad'));
  });

  it('**内容宽度单一来源**（原来有 640/760/820 三个值）', () => {
    assert.ok(token('--content-read'), '缺少 --content-read');
    assert.ok(token('--content-wide'), '缺少 --content-wide');
    // 不应再有裸的 760px / 820px 用作 max-width
    const bare760 = css.match(/max-width:\s*760px/g) ?? [];
    const bare820 = css.match(/max-width:\s*820px/g) ?? [];
    assert.equal(bare760.length, 0, '还有裸的 max-width: 760px');
    assert.equal(bare820.length, 0, '还有裸的 max-width: 820px');
  });

  it('输入框尺寸令牌化', () => {
    assert.equal(token('--composer-min-height'), '52px');
    assert.equal(token('--composer-max-height'), '180px');
    // 注意：:root 里的 --composer-max-height: 180px 定义本身不算\n    const bare180 = (css.match(/max-height:\s*180px/g) ?? []).filter(\n      (line) => true,\n    );\n    assert.equal(bare180.length, 0, '还有裸的 180px');
  });

  it('状态点尺寸统一', () => {
    assert.ok(token('--dot-size'));
    assert.ok(token('--dot-size-lg'));
  });

  it('滚动条宽度分两档（页内 / 细）', () => {
    assert.ok(token('--scrollbar-width'));
    assert.ok(token('--scrollbar-width-thin'));
  });
});
describe('**令牌不能引用自己**', () => {
  // 踩过：批量替换时把 `--composer-max-height: 180px` 也替换成了
  // `--composer-max-height: var(--composer-max-height)`。
  // 循环引用**不报错**，只是静默失效——输入框高度直接没了。
  it('没有自引用的令牌', () => {
    // **先去掉注释**——/* ... */ 里的示例文本会被误判成定义
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selfRefs: string[] = [];
    for (const m of noComments.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) {
      const name = m[1] ?? '';
      const value = m[2] ?? '';
      if (!name) continue;
      if (value.includes(`var(${name})`)) selfRefs.push(name);
    }
    assert.deepEqual(selfRefs, [], `这些令牌引用了自己: ${selfRefs.join(', ')}`);
  });
});