/**
 * 间距对齐 DSH。
 *
 * 用户反馈：「现在的界面太密了太挤了，你参考 DSH 的界面，改宽松一点」
 *
 * 从运行中的 DSH 抓到实测值（v0.9x）：
 *
 *     侧栏导航行    22px
 *     项目行        34px（文字本身 20px）
 *     会话行        32px（文字本身 20px）
 *     正文          16px / 行高 26px
 *     段落间距      16px
 *
 * **关键发现**：DSH 的行容器比文字高 12-14px，
 * 那点多余高度就是"留白"。我们之前行高 = 文字高度，所以显得密。
 */
import { allCss } from './_css.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = allCss;

/** 取某选择器第一处规则体。 */
function rule(selector: string): string {
  const m = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return m?.[1] ?? '';
}

/**
 * 合并某选择器**所有**规则的属性（后面的覆盖前面的）。
 *
 * 为什么需要：同一个选择器可能有多条规则（清理后仍保留了 19 个），
 * 只读第一条会漏掉真正的声明。
 */
function mergedRule(selector: string): string {
  const all = [...css.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  const props = new Map<string, string>();
  for (const m of all) {
    for (const line of (m[1] ?? '').split('\n')) {
      const pm = /^\s*([a-z-]+)\s*:\s*(.+?);?\s*$/.exec(line);
      if (pm) props.set(pm[1]!, pm[2]!);
    }
  }
  return [...props.entries()].map(([k, v]) => `${k}: ${v};`).join('\n');
}

describe('**行高对齐 DSH**', () => {
  /**
   * 以前这里断言 `.nav-item` 写死 `height: 30px`，理由是"字号 16px 需要更大行高"。
   *
   * 但字号已经并回 `--fs-sm`（14px），30px 就变成纯浪费；
   * 更要紧的是**四种 ListItem 场景出现了 26 / 30 / 32 三种高度**。
   *
   * 现在高度由 density 档决定（22 / 26 / 32），场景类不许自己写死。
   * 这条测试改成守"不许写死高度"。
   */
  it('导航行不许自己写死高度（交给 density 档）', () => {
    assert.doesNotMatch(
      rule('.nav-item'),
      /height:\s*\d+px/,
      '.nav-item 不该写死 px 高度，高度由 .list-item 的 density 档决定',
    );
  });

  it('**项目行也不许写死高度**', () => {
    assert.doesNotMatch(
      rule('.project-folder'),
      /height:\s*\d+px/,
      '.project-folder 不该写死 px 高度',
    );
  });

  it('行高统一来自 density 档（22 / 26 / 32）', () => {
    /**
     * 以前这里是"项目行 34px / 会话行 32px / 导航行 30px"三条独立断言，
     * 结果三种行高共存，同一屏里列表节奏不一致。
     *
     * 现在只有三档，由 `.list-item` 的 density 类决定。
     */
    const skeleton = rule('.list-item');
    assert.match(skeleton, /height:\s*var\(--h-md\)/, 'normal 档应为 --h-md');
    assert.match(rule('.list-item--compact'), /height:\s*var\(--h-sm\)/);
    assert.match(rule('.list-item--roomy'), /height:\s*var\(--h-lg\)/);
  });
});

describe('主区间距', () => {
  it('消息之间 16px', () => {
    assert.match(mergedRule('.messages'), /gap:\s*var\(--g-4\)/);
  });

  it('消息区四周 16px', () => {
    assert.match(mergedRule('.messages'), /padding:\s*var\(--g-4\)/);
  });

  it('气泡内边距用 10/12', () => {
    assert.match(mergedRule('.bubble'), /padding:\s*var\(--g-25\) var\(--g-3\)/);
  });
});

describe('**不许有拼错的值**', () => {
  // 踩过：`font-size: var(--fs-md) var(--fs-sm);` —— 两个值拼在一起，
  // 整条规则失效（和之前 `height: 22px var(--h-md)` 同一类错误）。
  it('CSS 值里没有两个 var 并列', () => {
    const bad = [...css.matchAll(/:\s*var\([^)]+\)\s+var\([^)]+\)\s*;/g)].map((m) => m[0]);
    // padding 之类允许 `var() var()`（上下 / 左右），但 font-size / height 不行
    const valueProps = bad.filter(
      (b) => /font-size:|height:|width:|line-height:|gap:/.test(b),
    );
    assert.deepEqual(valueProps, [], `这些值拼错了：${valueProps.join(' | ')}`);
  });
});
