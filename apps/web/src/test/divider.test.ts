/**
 * **分隔线为什么看起来"一条都没有"**
 *
 * 用户第三次指出来，这次是质问：
 * > 你来告诉我分隔线在哪里？右侧边栏和中间的分隔线，你来指一下，
 * > 为什么连一个像素都没有呢？
 *
 * ## 我前两次都改错了地方
 *
 * 第一次：`--color-border-subtle`（6% 白）→ `--color-border-strong`（11% 白）
 * 第二次：新增 `--color-border-divider`（20% 白）
 *
 * **两次都在改颜色。但真正的问题是那 1px 根本没画满。**
 *
 * 实测：`.rail` 的 `height` 是 **82px**，而视口高 1000——
 * border-left 只画了 82px 高的一小段，在深色背景上几乎看不见，
 * 看起来就是"一条线都没有"。
 *
 * ## 根因
 *
 * `.rail-slot`（右栏外壳）**完全没有样式**。它是 grid 的子项，
 * 内部 `.rail` 是 `min-height: 0` 的 flex 列，高度塌陷成内容高度。
 *
 * 修：外壳和 .rail 都明确撑满。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**分隔线必须画满整个高度**', () => {
  it('.rail-slot 有样式（之前完全没有）', () => {
    const body = rule('.rail-slot');
    assert.ok(body.length > 20, '.rail-slot 缺样式会导致右栏高度塌陷');
  });

  it('.rail-slot 撑满 grid 行高', () => {
    const body = rule('.rail-slot');
    assert.match(body, /height:\s*100%/);
    assert.match(body, /min-height:\s*0/);
  });

  it('.rail 在 slot 里撑满', () => {
    const m = /\.rail-slot > \.rail\s*\{([^}]*)\}/.exec(cleanCss);
    assert.ok(m, '需要有 .rail-slot > .rail 规则');
    assert.match(m[1] ?? '', /height:\s*100%/);
    assert.match(m[1] ?? '', /flex:\s*1 1 auto/);
  });

  it('分隔线是 0.5px solid + divider 色', () => {
    const body = rule('.rail');
    assert.match(body, /border-left:\s*0\.5px solid var\(--color-border-divider\)/);
  });
});

describe('左侧栏同理', () => {
  it('.sidebar 的 border-right 用 divder 档', () => {
    const all = [...cleanCss.matchAll(/^\.sidebar\s*\{([^}]*)\}/gm)].map((m) => m[1] ?? '').join('\n');
    assert.match(all, /border-right:\s*0\.5px solid var\(--color-border-divider\)/);
  });
});
