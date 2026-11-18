/**
 * 连续曲率的样式表契约。
 *
 * ## 为什么需要这个测试
 *
 * `corner-shape` 是**只在支持的引擎上生效**的视觉细节。
 * 漏掉一条 opt-out，在 Chromium 里正圆会悄悄变成方角——
 * 没有报错、没有控制台警告，只有看的人觉得"哪里怪"。
 *
 * 排查这类问题的成本极高（我们为了 `.jump-bottom` 变方角查了三轮）。
 * 所以用静态检查把这条约束固定下来。
 *
 * ## 两条规矩
 *
 * 1. 连续曲率只写在 `@supports` 里，用通用选择器覆盖（corner-shape 不继承）
 * 2. 每个全圆角（50% / 胶囊 / 大半径）都必须配 `corner-shape: round`
 *
 * 参照 DeepSeek Harness 的 `corner-shape-styles.client.spec.ts`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allCss } from './_css.js';

/** 去掉注释，避免注释里的示例代码被当成真规则。 */
const css: string = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

interface CssRule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyArray<readonly [string, string]>;
}

/** 解析成规则列表。 */
function parseRules(text: string): CssRule[] {
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const selectors = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const declarations = (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d): [string, string] => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      });
    rules.push({ selectors, declarations });
  }
  return rules;
}

/**
 * 从 `@supports (…)` 开始找配对的右括号。
 * @returns 块内容（不含外层花括号），找不到返回 null。
 */
function atRuleBody(text: string, prelude: string): string | null {
  const start = text.indexOf(prelude);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * **先剥掉 `@supports` 的外壳再解析**。
 *
 * 直接对整个文件跑 `选择器 { 声明 }` 的正则会匹配失败：
 * `@supports (...) {` 里的 `(...)` 会干扰选择器捕获，
 * 而且嵌套规则的括号会和外层串在一起。
 */
const guardBody = atRuleBody(css, '@supports (corner-shape: superellipse(1.5))');
const rules: CssRule[] = parseRules(guardBody ?? '');
/** 全文规则（用于检查全圆角配对，那个不受 @supports 影响）。 */
const allRules: CssRule[] = parseRules(css);

/**
 * 这个 radius 值是否让元素变成全圆角。
 *
 * 判据（照 DSH）：
 * - `50%` / `100%`：横纵各占一半
 * - `>=99px`：大到必然超过盒子尺寸，胶囊常用
 * - `calc(var(--h-*) / 2)`：我们表达胶囊的方式
 * - `var(--r-full)`：指向 50% 的令牌
 */
function isFullRound(value: string): boolean {
  /**
   * **先整体判断胶囊，再按空格拆**。
   *
   * `calc(var(--h-md) / 2)` 里含空格，直接 `split(/\s+/)` 会把它切成
   * `calc(var(--h-md)` / `/` / `2)` 三块，正则匹配不上——
   * 于是所有胶囊元素都被漏检（自测抓到的）。
   */
  const compact = value.replace(/\s+/g, ' ').trim();
  if (/^calc\(\s*var\(--h-[a-z]+\)\s*\/\s*2\s*\)$/.test(compact)) return true;

  return compact.split(' ').some((part) => {
    if (part === '50%' || part === '100%') return true;
    if (part.endsWith('px') && Number.parseFloat(part) >= 99) return true;
    if (part === 'var(--r-full)') return true;
    return false;
  });
}

/** 有全圆角 border-radius 的规则。 */
const fullRoundRules = allRules.filter((r) =>
  r.declarations.some(([p, v]) => p === 'border-radius' && isFullRound(v)),
);

describe('**连续曲率：覆盖方式**', () => {
  it('参数是 superellipse(1.5)，不是 squircle', () => {
    /**
     * 实测 `superellipse(2)` 等于 `squircle`。
     * 1.5 介于圆弧（1）与它之间——4~8px 的小圆角不会显得硬。
     */
    assert.match(css, /--corner-shape:\s*superellipse\(1\.5\)/);
    assert.doesNotMatch(
      css,
      /corner-shape:\s*squircle/,
      'squircle 等于 superellipse(2)，太方；应该用 1.5',
    );
  });

  it('用通用选择器覆盖（corner-shape 不继承）', () => {
    // 手写类名清单会漏——新增的组件不会自动获得连续曲率
    const universal = rules.find((r) => r.selectors.includes('*'));
    assert.ok(universal, '找不到通用选择器规则');
    assert.ok(
      universal.selectors.includes('*::before') && universal.selectors.includes('*::after'),
      '伪元素也要覆盖',
    );
    assert.ok(
      universal.declarations.some(
        ([p, v]) => p === 'corner-shape' && (v ?? '').includes('--corner-shape'),
      ),
      '通用选择器要引用 --corner-shape 令牌',
    );
  });

  it('只在 @supports 里声明', () => {
    // 不支持的引擎会忽略，退回普通圆角——不会坏
    assert.match(css, /@supports \(corner-shape: superellipse\(1\.5\)\)/);
  });
});

describe('**连续曲率：全圆角必须 opt out**', () => {
  it('检测函数本身是对的', () => {
    // 先自测：避免"检查器坏了却一直通过"
    assert.equal(isFullRound('50%'), true);
    assert.equal(isFullRound('999px'), true);
    assert.equal(isFullRound('calc(var(--h-md) / 2)'), true);
    assert.equal(isFullRound('var(--r-full)'), true);
    assert.equal(isFullRound('4px'), false);
    assert.equal(isFullRound('var(--r-xs)'), false);
  });

  it('每条全圆角规则都配了 corner-shape: round', () => {
    const unpaired = fullRoundRules
      .filter((r) => !r.declarations.some(([p, v]) => p === 'corner-shape' && v === 'round'))
      .map((r) => r.selectors.join(', '));

    assert.deepEqual(
      unpaired,
      [],
      `这些全圆角元素会被超椭圆压方，需要加 corner-shape: round：\n  ${unpaired.join('\n  ')}`,
    );
  });

  it('至少找到了若干个全圆角元素（防止检查器空转）', () => {
    assert.ok(
      fullRoundRules.length >= 8,
      `只找到 ${fullRoundRules.length} 个全圆角元素，检查逻辑可能失效了`,
    );
  });
});
