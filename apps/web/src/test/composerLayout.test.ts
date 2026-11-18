/**
 * **输入区的结构不能塌。**
 *
 * 用户报告：「你先看看最下面的对话框，直接改坏了」
 *
 * 现象：项目选择器、输入框、按钮全挤在一行，按钮文字竖排。
 *
 * 根因：**构建产物 (dist) 与源码不一致**——
 * 有一次合并脚本错误的把 `.status-bar` 的属性并进了
 * `.composer-box, .status-bar` 这条选择器组，
 * 于是 `.composer-box` 拿到了 `display: flex`（方向 row），
 * 三个子元素横排。
 *
 * 源码回滚了，但 dist 还是旧的那份，所以构建出来的还是坏的。
 *
 * 教训：**改 CSS 后必须整个删 dist 重建**，不能只依赖增量构建。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const m = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm').exec(cleanCss);
  return m?.[1] ?? '';
}

describe('**输入区三个子元素必须竖排**', () => {
  it('.composer-box 不能是 flex row', () => {
    // 它有三个子元素：.composer-picker-row / textarea / .composer-bar
    // 如果是 flex 且没设 column，三个会横排
    const body = rule('.composer-box');
    if (/display:\s*flex/.test(body)) {
      assert.match(body, /flex-direction:\s*column/, '.composer-box 是 flex 就必须 column');
    }
  });

  it('**不许把 .composer-box 和 .status-bar 并进同一个选择器组**', () => {
    // 踩过：这两个被合并后，.status-bar 的 display:flex / font-size / color
    // 等属性泄漏到了 .composer-box 上。
    const blocks = [...cleanCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const m of blocks) {
      const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
      if (!selectors.includes('.composer-box')) continue;
      assert.ok(
        !selectors.includes('.status-bar'),
        `这两个元素用途完全不同，不能共用规则：${selectors.join(', ')}`,
      );
    }
  });

  it('.status-bar 的布局属性不外泄', () => {
    const blocks = [...cleanCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const m of blocks) {
      const selectors = (m[1] ?? '').split(',').map((s) => s.trim());
      if (!selectors.includes('.composer-box')) continue;
      const body = m[2] ?? '';
      // status-bar 特有的属性不该出现在 composer-box 的选择器组里
      assert.doesNotMatch(body, /justify-content:\s*flex-end/, 'flex-end 是状态栏的');
    }
  });
});

describe('输入区各部件独立', () => {
  it('.composer-bar 是横排', () => {
    const body = rule('.composer-bar');
    assert.match(body, /display:\s*flex/);
    assert.match(body, /justify-content:\s*space-between/);
  });

  it('.composer-picker-row 是横排', () => {
    assert.match(rule('.composer-picker-row'), /display:\s*flex/);
  });
});
