import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * desktop-agent-ui 验收清单里最后两项。
 *
 * ## 1. 弹窗滚动槽位防抖
 *
 * 不预留滚动条槽位时：打开设置页 / 弹窗 → 浮层盖住滚动条 → 槽位消失 →
 * 整页内容**横向跳 2~3px**，关掉又跳回去。文字密集的对话区特别明显。
 *
 * ## 2. 附件卡片过渡
 *
 * 增删附件时 chip 是原生 DOM 重排，瞬间跳到新位置。
 * View Transitions 让浏览器自己把同一个 chip 从旧位置平移过去。
 *
 * ## 为什么必须剥掉 CSS 注释
 *
 * 上一轮踩过：注释里也有花括号和 "height" 字样，正则会在注释处提前截断，
 * 导致断言假失败。所有 CSS 断言都先过 `stripCssComments`。
 */

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

/** 剥掉 CSS 注释——注释里的花括号会让正则提前截断。 */
const stripCssComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

const clean = stripCssComments(css);

/** 取某个选择器的规则体（取第一个匹配）。 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(clean);
  return m?.[1] ?? '';
}

describe('**滚动槽位防抖**', () => {
  it('.messages 预留滚动条槽位', () => {
    // `.messages` 在 styles.css 里有**四处**定义（后三处是响应式覆盖），
    // 所以不能只取第一块——要把所有同名规则的体拼起来看。
    const bodies = [...clean.matchAll(/^\.messages\s*\{([^}]*)\}/gm)].map((m) => m[1] ?? '');
    assert.ok(bodies.length > 0, '找不到 .messages 规则');
    assert.ok(
      bodies.some((b) => /scrollbar-gutter:\s*stable/.test(b)),
      '主对话滚动区没有预留滚动条槽位',
    );
  });

  it('.settings-overlay 预留槽位', () => {
    assert.match(rule('.settings-overlay'), /scrollbar-gutter:\s*stable/);
  });

  it('.modal-backdrop 预留槽位', () => {
    assert.match(rule('.modal-backdrop'), /scrollbar-gutter:\s*stable/);
  });

  it('**不许引入 scrollbar-width**', () => {
    // 设了标准 scrollbar-width 后，Chromium 会忽略 `::-webkit-scrollbar`
    // 的宽度，整站的细滚动条全部失效。
    // controlSpec.test.ts 已有一条守着，这里再守一次——本次改动最容易犯这个错。
    const hits = clean.match(/^\s*scrollbar-width:\s*(?!auto)[\w-]+;/gm) ?? [];
    assert.deepEqual(hits, [], `不该设置 scrollbar-width: ${hits.join(' ')}`);
  });
});

describe('**附件卡片过渡**', () => {
  const strip = readFileSync(
    new URL('../../src/components/AttachmentStrip.tsx', import.meta.url),
    'utf8',
  );

  it('每个 chip 都带 viewTransitionName', () => {
    assert.match(strip, /viewTransitionName/, '没有接 View Transitions');
  });

  it('用附件 id 命名（增删时才认得出是同一个 chip）', () => {
    assert.match(
      strip,
      /viewTransitionName:\s*`attach-\$\{att\.id\}`/,
      '名字没带 id —— 浏览器无法把前后两次渲染认成同一个元素',
    );
  });
});
