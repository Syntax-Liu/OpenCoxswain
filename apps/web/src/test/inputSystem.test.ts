/**
 * 输入框组件契约。
 *
 * 改造前实测：同一个输入框在 5 个容器里各定义一遍，
 *   圆角有 --r-sm 和 --r-md 两种（本就不该有两种），
 *   内边距有 9/11、6/9、5/8、7/9 四组，
 *   焦点态有 3 种实现（其中 3 处是改 border-color，会撑动布局）。
 *
 * 这里锁住：
 *   1. .input 契约存在且五态齐全；
 *   2. 各容器不再重复定义背景/边框/圆角；
 *   3. 焦点态不再靠改 border-color。
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

describe('**输入框有统一契约**', () => {
  it('基础样式作用于全局 input / select', () => {
    // 关键事实：36 处 <input> 都没有 className，靠全局选择器定样式。
    // 因此基础规则必须是 `input {` 而不是 `.input {`——后者对它们无效。
    const body = rule('input');
    assert.ok(body.length > 0, '缺少全局 input 规则');
    assert.match(body, /background:\s*var\(--color-surface-sunken\)/);
    assert.match(body, /border:\s*0\.5px solid var\(--color-border-strong\)/);
    assert.match(body, /border-radius:\s*var\(--r-sm\)/);
  });

  it('尺寸与状态变体齐全', () => {
    assert.ok(rule('.input--sm').length > 0, '缺少 .input--sm');
    assert.ok(rule('.input--bare').length > 0, '缺少 .input--bare');
  });

  it('**焦点用 outline，不改边框**（改边框会撑动布局）', () => {
    // 焦点规则同样作用于全局 input
    assert.match(cleanCss, /^input:focus,/m);
    const idx = cleanCss.indexOf('input:focus,');
    const focusBlock = cleanCss.slice(idx, idx + 260);
    assert.match(focusBlock, /outline:\s*2px solid var\(--color-border-focus\)/);
    assert.match(focusBlock, /outline-offset:\s*-1px/);
  });

  it('禁用态有视觉区分', () => {
    const idx = cleanCss.indexOf('input:disabled');
    assert.ok(idx > 0, '缺少 input:disabled');
    assert.match(cleanCss.slice(idx, idx + 120), /opacity:/);
  });
});

describe('**各容器不再重复定义输入框外观**', () => {
  const styled = ['.field input', '.approval-actions input', '.sidebar-filter input'];

  for (const selector of styled) {
    it(`${selector} 只剩布局属性`, () => {
      const body = rule(selector);
      // 这些属性应当交给 .input，容器里不许再出现
      for (const prop of ['background', 'border', 'border-radius', 'color']) {
        assert.doesNotMatch(
          body,
          new RegExp(`(^|[\\s;])${prop}\\s*:`),
          `${selector} 仍在定义 ${prop}`,
        );
      }
    });
  }

  it('**不许再出现「改 border-color 的焦点态」**', () => {
    // 契约自身把边框设为 transparent 是正确做法（让 outline 独占焦点提示），
    // 这里要防的是「各容器用 border-color 变色表达焦点」的回退。
    const bad = [...cleanCss.matchAll(/([^{}]*input[^{}]*:focus[^{]*)\{([^}]*)\}/g)]
      .filter((m) => {
        const selector = (m[1] ?? '').trim();
        if (selector.startsWith('.input:focus')) return false; // 契约自身豁免
        return /border-color\s*:\s*var\(--/.test(m[2] ?? '');
      })
      .map((m) => (m[1] ?? '').trim());
    assert.deepEqual(bad, [], '输入框焦点态又用回 border-color 变色');
  });
});

describe('**输入框字号与内边距用令牌**', () => {
  it('容器里的 padding 不再是裸像素', () => {
    for (const selector of ['.field input', '.approval-actions input', '.sidebar-filter input']) {
      const body = rule(selector);
      assert.doesNotMatch(body, /padding:\s*\d+px/, `${selector} 的 padding 又是裸像素`);
    }
  });
});
