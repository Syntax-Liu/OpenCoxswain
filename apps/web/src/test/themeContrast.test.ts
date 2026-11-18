/**
 * 主题对比度纪律（WCAG 2.1）。
 *
 * 为什么放进测试：改一个原始层色值，会影响所有引用它的组件。
 * 静态锁值（tokens.test.ts）能防"意外改"，但防不了"改成了看不清的值"。
 * 这里补上可读性这条底线。
 *
 * 阈值：
 *   正文 / 次要文字 / 状态色（红绿）≥ 4.5:1（AA 正文）
 *   元信息 / 警告 / 信息 / 强调 ≥ 3:1（大字号或非文字元素）
 *
 * 对应文档：docs/ui-consistency-plan.md §14
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;

function parseBlock(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1]!, m[2]!.trim());
  }
  return map;
}

const darkBlock = parseBlock(/:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '');
const lightBlock = parseBlock(/:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '');

function parseColor(v: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
  if (rgb) {
    const p = rgb[1]!.split(',').map((s) => parseFloat(s.trim()));
    return [p[0]!, p[1]!, p[2]!];
  }
  return null;
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 语义令牌 → 原始令牌。 */
const semantic = new Map<string, string>();
for (const m of css
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .matchAll(/^\s*(--color-[\w-]+):\s*var\((--[\w-]+)\);/gm)) {
  semantic.set(m[1]!, m[2]!);
}

const SURFACES = [
  '--color-surface-canvas',
  '--color-surface-sidebar',
  '--color-surface-panel',
  '--color-surface-raised',
];

const TEXT_TOKENS: Record<string, number> = {
  '--color-label-primary': 4.5,
  '--color-label-secondary': 4.5,
  '--color-label-tertiary': 3.0,
  '--color-label-strong': 4.5,
  '--color-danger': 4.5,
  '--color-success': 4.5,
  '--color-warn': 3.0,
  '--color-info': 3.0,
  '--color-action': 3.0,
};

for (const [themeName, block] of [
  ['dark', darkBlock],
  ['light', lightBlock],
] as const) {
  describe(`**${themeName} 主题文字可读性**`, () => {
    for (const [token, min] of Object.entries(TEXT_TOKENS)) {
      it(`${token.replace('--color-', '')} 在四种表面上都 ≥ ${min}:1`, () => {
        const primName = semantic.get(token);
        assert.ok(primName, `${token} 没有映射到原始层`);
        const fgRaw = block.get(primName);
        assert.ok(fgRaw, `${themeName} 下缺少 ${primName}`);
        const fg = parseColor(fgRaw);
        assert.ok(fg, `${primName} 不是可解析的颜色：${fgRaw}`);

        const bad: string[] = [];
        for (const surface of SURFACES) {
          const sPrim = semantic.get(surface);
          if (!sPrim) continue;
          const bgRaw = block.get(sPrim);
          if (!bgRaw) continue;
          const bg = parseColor(bgRaw);
          if (!bg) continue;
          const r = contrast(fg!, bg);
          if (r < min) bad.push(`${surface.replace('--color-surface-', '')}=${r.toFixed(2)}`);
        }
        assert.deepEqual(bad, [], `${token} 对比度不足：${bad.join(', ')}`);
      });
    }
  });
}

describe('**浅色主题确实覆盖了关键色板**', () => {
  it('中性色与功能色都有浅色值', () => {
    for (const key of ['--c-neutral-950', '--c-neutral-100', '--c-amber-400', '--c-red-500']) {
      assert.ok(lightBlock.has(key), `浅色主题缺少 ${key}`);
    }
  });

  it('浅色画布是亮的、文字是暗的（不是照抄深色）', () => {
    const canvas = parseColor(lightBlock.get('--c-neutral-950')!);
    const text = parseColor(lightBlock.get('--c-neutral-1000')!);
    assert.ok(canvas && text);
    assert.ok(luminance(canvas!) > 0.8, '浅色画布应当接近白色');
    assert.ok(luminance(text!) < 0.2, '浅色正文应当接近黑色');
  });
});
