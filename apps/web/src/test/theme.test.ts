/**
 * 主题（暗色 / 亮色）。
 *
 * 核心约束：**切换主题只覆盖原始色板，不改组件规则**。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DEFAULT_THEME,
  THEME_OPTIONS,
  applyTheme,
  parseTheme,
} from '../components/theme.js';

const css = allCss;

describe('档位', () => {
  it('两档：暗色 / 亮色', () => {
    assert.equal(THEME_OPTIONS.length, 2);
    assert.deepEqual(
      THEME_OPTIONS.map((o) => o.id),
      ['dark', 'light'],
    );
  });

  it('每档都有中文标签', () => {
    for (const o of THEME_OPTIONS) assert.ok(o.label.length > 0);
  });

  it('**默认是暗色**（产品最初的本色）', () => {
    assert.equal(DEFAULT_THEME, 'dark');
  });
});

describe('解析存储值', () => {
  it('合法值原样返回', () => {
    assert.equal(parseTheme('light'), 'light');
    assert.equal(parseTheme('dark'), 'dark');
  });

  it('**非法值退回默认**，不崩', () => {
    assert.equal(parseTheme('blue'), 'dark');
    assert.equal(parseTheme(''), 'dark');
    assert.equal(parseTheme(null), 'dark');
    assert.equal(parseTheme(undefined), 'dark');
  });
});

describe('应用', () => {
  it('**亮色设 data-theme 属性**', () => {
    const attrs = new Map<string, string>();
    const fakeRoot = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;

    applyTheme('light', fakeRoot);
    assert.equal(attrs.get('data-theme'), 'light');
  });

  it('**暗色去掉属性**（默认值不需要覆盖）', () => {
    const attrs = new Map<string, string>([['data-theme', 'light']]);
    const fakeRoot = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;

    applyTheme('dark', fakeRoot);
    assert.equal(attrs.has('data-theme'), false);
  });
});

describe('**亮色只覆盖色板，不改语义层**', () => {
  it('CSS 里有 [data-theme=light] 的色板覆盖', () => {
    assert.match(css, /\[data-theme='light'\]/);
  });

  it('亮色块里重新定义了中性色阶', () => {
    const m = /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css);
    assert.ok(m, '找不到亮色色板定义');
    const body = m[1] ?? '';
    assert.match(body, /--c-neutral-950:/, '缺少画布色');
    assert.match(body, /--c-neutral-100:/, '缺少标题文字色');
  });

  it('亮色块里**不重新定义语义层**（应该自动跟随）', () => {
    const m = /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css);
    const body = m?.[1] ?? '';
    assert.doesNotMatch(body, /--color-surface-/, '语义层不该在主题里重定义');
    assert.doesNotMatch(body, /--color-label-/, '语义层不该在主题里重定义');
  });

  it('亮色的画布是白色', () => {
    const m = /\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css);
    const body = m?.[1] ?? '';
    const canvas = /--c-neutral-950:\s*([^;]+);/.exec(body);
    assert.equal((canvas?.[1] ?? '').trim().toLowerCase(), '#ffffff');
  });
});

describe('**圆角照搬 DSH**', () => {
  // DSH 实测：xs=4 sm=8 md=12 lg=16 xl=20
  const expected: Record<string, string> = {
    '--r-xs': '4px',
    '--r-sm': '8px',
    '--r-md': '12px',
    '--r-lg': '16px',
    '--r-xl': '20px',
  };

  for (const [name, value] of Object.entries(expected)) {
    it(`${name} = ${value}`, () => {
      const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
      assert.equal((m?.[1] ?? '').trim(), value);
    });
  }
});
