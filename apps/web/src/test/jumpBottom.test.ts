/**
 * 「回到底部」按钮的形态（照 DSH / TRAE / WorkBuddy）。
 *
 * ## 历史
 *
 * 1. 主样式在清理 CSS 时被误删，只剩孤立的 `.jump-bottom:hover`
 *    → 按钮退化成通用 button 样式，变成横贯全宽的白色长条
 * 2. 修成圆形后，用 `bottom: 12px` 挂在 `.conversation` 上
 *    → 实测落在输入框里面（按钮 956~988、输入区 837~978），挡住消息内容
 * 3. 现在挂在 `.composer` 内部，`bottom: calc(100% + 8px)`
 *    → 永远在输入区上沿之外
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
    // --r-full 是 50%，配合 32px 高度就是正圆（圆角只允许 token 或 0/50%）
    assert.match(body, /border-radius:\s*var\(--r-full\)/);
  });

  it('**挂在输入区上沿之外，不挡消息内容**', () => {
    const body = rule('.jump-bottom');
    assert.match(body, /position:\s*absolute/);
    assert.match(body, /left:\s*50%/);
    assert.match(body, /transform:\s*translateX\(-50%\)/);
    // bottom: 100% 相对 .composer 的高度——按钮永远在输入框正上方。
    // 用 bottom: 12px 会落在输入框里面。
    assert.match(body, /bottom:\s*calc\(100% \+/, '要挂在输入区上沿之外');
  });

  it('**不许撑满宽度**（那是"长条"的成因）', () => {
    const body = rule('.jump-bottom');
    assert.doesNotMatch(body, /width:\s*100%/);
    assert.doesNotMatch(body, /width:\s*auto/);
  });

  it('有阴影，浮在内容上方', () => {
    assert.match(rule('.jump-bottom'), /box-shadow:/);
  });
});

describe('按钮在 .composer 内部、composer-box 之前', () => {
  it('位置正确', () => {
    const boxMarker = '<div className="composer-box">';
    const boxIdx = conversation.indexOf(boxMarker);
    const btnIdx = conversation.indexOf('jump-bottom');
    assert.ok(boxIdx > 0, '找不到 composer-box');
    assert.ok(btnIdx > 0, '找不到 jump-bottom');
    assert.ok(btnIdx < boxIdx, '按钮应该在 composer-box 之前（输入区内、框的上方）');
  });
});

describe('按钮内容：箭头，或未读数字', () => {
  it('没有未读时只显示向下箭头', () => {
    assert.match(conversation, /scroll\.unread > 0 \? <span>\{scroll\.unread\}<\/span> : <IconChevron/);
  });

  it('不再渲染"回到底部"这几个字', () => {
    const jsx = conversation.replace(/title=\{[^}]*\}/g, '').replace(/aria-label=\{[^}]*\}/g, '');
    const at = jsx.indexOf('jump-bottom');
    const area = jsx.slice(at, at + 600);
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
