/**
 * 「回到底部」按钮的形态（照 DSH / TRAE / WorkBuddy）。
 *
 * 用户原话：
 * > 这个回到底部太丑了，看看 DSH、TRAE、Workbuddy，都是一个圆圈，然后一个下箭头
 *
 * ## 根因是我自己埋的
 *
 * `.jump-bottom` 的**主样式在之前清理 CSS 时被误删了**，
 * 只剩一条孤立的 `.jump-bottom:hover`。
 *
 * 于是这个按钮退化成通用 `button` 样式——宽度撑满父容器（1035px），
 * 变成一条横贯整个内容区的白色长条。
 *
 * 教训：清理 CSS 时要确认删的是「死代码」，不是「唯一的定义」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const conversation = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**「回到底部」是圆形按钮，不是长条**', () => {
  it('有主样式定义（曾经被误删，只剩 hover）', () => {
    const body = rule('.jump-bottom');
    assert.ok(body.length > 100, `.jump-bottom 主样式缺失或过短（${body.length} 字符）`);
  });

  it('32×32 的圆形', () => {
    const body = rule('.jump-bottom');
    assert.match(body, /height:\s*32px/);
    assert.match(body, /min-width:\s*32px/);
    // --r-full 是 50%，配合 32px 高度就是正圆（不能用硬编码 16px——圆角只允许 token 或 0/50%）
    assert.match(body, /border-radius:\s*var\(--r-full\)/, '要用圆角 token');
  });

  it('悬浮在底部居中', () => {
    const body = rule('.jump-bottom');
    assert.match(body, /position:\s*absolute/);
    assert.match(body, /left:\s*50%/);
    assert.match(body, /transform:\s*translateX\(-50%\)/);
  });

  it('**不许撑满宽度**（那是"长条"的成因）', () => {
    const body = rule('.jump-bottom');
    assert.doesNotMatch(body, /width:\s*100%/, '不能设 width: 100%');
    assert.doesNotMatch(body, /width:\s*auto/, '不能设 width: auto 让它被 flex 拉伸');
  });

  it('有阴影，浮在内容上方', () => {
    assert.match(rule('.jump-bottom'), /box-shadow:/);
  });
});

describe('按钮内容：箭头，或未读数字', () => {
  it('没有未读时只显示向下箭头', () => {
    assert.match(conversation, /scroll\.unread > 0 \? <span>\{scroll\.unread\}<\/span> : <IconChevron/);
  });

  it('不再渲染"回到底部"这几个字', () => {
    // 文字只该在 title / aria-label 里
    const jsx = conversation.replace(/title=\{[^}]*\}/g, '').replace(/aria-label=\{[^}]*\}/g, '');
    const area = jsx.slice(jsx.indexOf('jump-bottom'), jsx.indexOf('jump-bottom') + 600);
    assert.doesNotMatch(area, />\s*回到底部\s*</);
  });

  it('有未读时加 has-unread 类', () => {
    assert.match(conversation, /has-unread/);
    assert.match(rule('.jump-bottom.has-unread'), /padding:/);
  });

  it('有无障碍标签', () => {
    assert.match(conversation, /aria-label=\{scroll\.unread > 0/);
  });
});
