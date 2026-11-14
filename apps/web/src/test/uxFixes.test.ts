/**
 * 三个用户反复指出的问题，用测试锁死。
 *
 * ## 问题 1
 *
 * > 每次打开 Assistant 都是在最顶部的位置，需要用户手动下滑到最新内容
 *
 * 原因：`useAutoScroll` 只监听**消息条数**。切换会话时条数可能不变，
 * 就完全不会滚动。现在加 `identity`（项目 + 会话），变化时强制到底。
 *
 * ## 问题 2
 *
 * > 编辑重发复制等按钮…占位了，导致对话框总是有一行空白
 *
 * 原因：`.bubble-footer` 用 `opacity: 0` 隐藏，但仍在文档流里。
 * 改成 `position: absolute` 脱离文档流。
 *
 * ## 问题 3
 *
 * > 图标还是偏上视觉上无法与文字对齐
 *
 * 原因：**图标本身在 16×16 视口里画得不居中**。
 * `IconSupervisor` 的绘制中线在 y=6.38（视口中心是 8），
 * 所以盒子中线对齐了也没用——图看起来还是偏上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');
const scrollHook = readFileSync(new URL('../../src/components/useAutoScroll.ts', import.meta.url), 'utf8');
const conversation = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**问题1：打开会话必须在底部**', () => {
  it('useAutoScroll 接受会话身份参数', () => {
    assert.match(scrollHook, /identity\?: string/);
  });

  it('身份变化时强制滚到底', () => {
    assert.match(scrollHook, /\}, \[identity\]\)/);
  });

  it('Conversation 传了 identity', () => {
    assert.match(conversation, /useAutoScroll\(visible\.length, scrollIdentity\)/);
  });

  it('identity 能区分不同会话', () => {
    // 必须包含项目 id + 会话标识，否则不同会话的 identity 相同
    assert.match(conversation, /scrollIdentity = `\$\{props\.project\.id\}:\$\{props\.draftKey\}`/);
  });
});

describe('**问题2：消息操作按钮不能占位**', () => {
  it('.bubble-footer 是绝对定位', () => {
    const body = rule('.bubble-footer');
    assert.match(body, /position:\s*absolute/, '占位的根源是它在文档流里');
  });

  it('平时不吃鼠标事件', () => {
    assert.match(rule('.bubble-footer'), /pointer-events:\s*none/);
  });

  it('悬停时可点', () => {
    const m = /\.message:hover \.bubble-footer[\s\S]{0,200}?\{([^}]*)\}/.exec(cleanCss);
    assert.match(m?.[1] ?? '', /pointer-events:\s*auto/);
  });

  it('.message 是定位上下文', () => {
    assert.match(rule('.message'), /position:\s*relative/);
  });

  it('不再用 margin-top 撑开空间', () => {
    assert.doesNotMatch(rule('.bubble-footer'), /margin-top:\s*4px/);
  });
});

describe('**问题3：图标在视口里必须居中**', () => {
  // 只查能用正则可靠解析的 circle / rect。
  // path 的精确验证见浏览器实测（16 个图标全部偏离 ≤0.25px）。
  function iconBody(name: string): string {
    const m = new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`).exec(icons);
    return m?.[0] ?? '';
  }

  it('IconSupervisor 的图形居中（曾经偏上 1.62px）', () => {
    const body = iconBody('IconSupervisor');
    const circles = [...body.matchAll(/<circle\s+cx="[\d.]+"\s+cy="([\d.]+)"\s+r="([\d.]+)"/g)]
      .map((m) => ({ cy: Number(m[1]), r: Number(m[2]) }));
    assert.ok(circles.length >= 4, '应该有中心 + 三个外围节点');
    const minY = Math.min(...circles.map((c) => c.cy - c.r));
    const maxY = Math.max(...circles.map((c) => c.cy + c.r));
    const mid = (minY + maxY) / 2;
    assert.ok(
      Math.abs(mid - 8) <= 0.6,
      `图形中线应该在 8 附近（实际 ${mid.toFixed(2)}）——偏了就是"图标偏上"`,
    );
  });

  it('IconMemory 的图形居中（曾经偏下 1.25px）', () => {
    const body = iconBody('IconMemory');
    // 两个气泡的 path 都是 M x y ... 起始 y 决定上沿
    const starts = [...body.matchAll(/<path\s+d="M([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]));
    assert.ok(starts.length >= 2, '应该有两个气泡');
    assert.ok(Math.min(...starts) <= 3, `上沿 y=${Math.min(...starts)} 太高，会偏下`);
  });

  it('所有图标都用统一视口', () => {
    assert.match(icons, /viewBox: '0 0 16 16'/);
  });
});
