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

describe('改造前后颜色一致', () => {
  // 这些是改造前 :root 里的原始值，逐一核对
  const expected: Record<string, string> = {
    '--c-neutral-950': '#0a0c0f',
    '--c-neutral-900': '#0d1013',
    '--c-neutral-880': '#0e1216',
    '--c-neutral-850': '#11151a',
    '--c-neutral-800': '#171c23',
    '--c-neutral-750': '#1a2028',
    '--c-neutral-700': '#1f262f',
    '--c-neutral-600': '#545c65',
    '--c-neutral-500': '#7a828b',
    '--c-neutral-300': '#c4cbd3',
    '--c-neutral-100': '#e8eaed',
    '--c-amber-600': '#6b4f22',
    '--c-amber-500': '#c98b4b',
    '--c-amber-400': '#e0a04a',
    '--c-amber-300': '#eab366',
    '--c-green-500': '#5a8f7b',
    '--c-red-500': '#b85450',
    '--c-blue-500': '#5a7d99',
  };

  for (const [name, hex] of Object.entries(expected)) {
    it(`${name} = ${hex}（与改造前一致）`, () => {
      assert.equal((token(name) ?? '').toLowerCase(), hex.toLowerCase());
    });
  }
});
