/**
 * 颜色令牌的分层纪律。
 *
 * 三轮改造的核心成果之一：**组件区不再有任何裸色值**。
 * 此前的实际状况：约 50 处写死的十六进制 / rgba（VS Code 遗留配色），
 * 它们在浅色主题下不会跟随切换，是主题失效的根源。
 *
 * 这里锁住：
 *   1. 原始层（:root 内的 --c-*）是唯一允许写色值的地方；
 *   2. 语义层（--color-*）只能引用原始层；
 *   3. 组件区（:root 与 :root[data-theme] 之外）零裸色值。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

/** 取组件区：所有主题/令牌声明块之后的所有内容。 */
function componentArea(): string {
  // 允许写色值的区域：
  //   :root { --c-*: #xxx }
  //   :root[data-theme='light'] { ... }
  //   :root[data-theme='light'] .template-picker { box-shadow: ... }  ← 主题专属覆写
  // 其余（真正的组件样式）一律不许出现裸色值。
  let last = 0;
  for (const m of cleanCss.matchAll(/:root(\[[^\]]*\])?[^{]*\{/g)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < cleanCss.length && depth > 0) {
      if (cleanCss[i] === '{') depth += 1;
      else if (cleanCss[i] === '}') depth -= 1;
      i += 1;
    }
    last = Math.max(last, i);
  }
  return cleanCss.slice(last);
}

describe('**组件区零裸色值**', () => {
  it('注释之外、令牌声明之外，不再出现十六进制或 rgb()', () => {
    const area = componentArea();
    const found = [...area.matchAll(COLOR_RE)].map((m) => m[0]);
    assert.deepEqual(
      [...new Set(found)],
      [],
      `组件区仍有裸色值（不会跟随主题切换）：${[...new Set(found)].slice(0, 8).join(', ')}`,
    );
  });

  it('颜色一律通过 var(--color-*) 或 var(--c-*) 引用', () => {
    const area = componentArea();
    const declarations = [...area.matchAll(/:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g)];
    assert.equal(declarations.length, 0);
  });
});

describe('**语义层只引用原始层**', () => {
  it('--color-* 的值必须是 var(--c-*)', () => {
    const violations = [...cleanCss.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)]
      .filter((m) => !/^var\(--c-/.test((m[2] ?? '').trim()))
      .map((m) => m[1]);
    assert.deepEqual(violations, [], `这些语义令牌直写了色值：${violations.join(', ')}`);
  });

  it('原始层确实存的是色值', () => {
    assert.match(cleanCss, /--c-neutral-950:\s*#[0-9a-f]{6}/i);
    assert.match(cleanCss, /--c-amber-400:\s*#[0-9a-f]{6}/i);
  });
});

describe('**改造中新增的令牌都在**', () => {
  const required = [
    '--color-scrim',
    '--color-on-accent',
    '--color-code-bg',
    '--color-trace-user',
    '--color-trace-assistant',
    '--color-trace-tool',
    '--shadow-popover',
    '--shadow-menu',
    '--shadow-modal',
  ];
  for (const token of required) {
    it(`${token} 已定义`, () => {
      assert.ok(cleanCss.includes(`${token}:`), `缺少 ${token}`);
    });
  }
});
