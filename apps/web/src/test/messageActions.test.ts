/**
 * 消息操作按钮的形态（照 DSH）。
 *
 * 用户指着 DSH 截图说：
 * > 编辑重发复制，我让你参考 DSH，你看不见吗？
 *
 * DSH 是一排**小的圆形图标按钮**（复制 / 点赞 / 点踩），
 * 紧贴消息内容下方左侧，**常显**。
 *
 * 我前两次都做错了：
 *   1. 文字链（编辑 / 重发 / 复制）—— 又长又不是 DSH 的样子
 *   2. 绝对定位 + 悬停才显示 —— 不占位了，但形态还是文字
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const actions = readFileSync(new URL('../../src/components/MessageActions.tsx', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../../src/components/icons.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**操作按钮是图标，不是文字**', () => {
  it('用 .msg-action-btn 而不是文字链 .link', () => {
    assert.match(actions, /className="msg-action-btn"/);
    assert.doesNotMatch(actions, /className="link"/, '不该再用文字链');
  });

  it('按钮里是 SVG 图标', () => {
    for (const icon of ['IconCopy', 'IconCheck', 'IconRetry', 'IconEdit']) {
      assert.match(icons, new RegExp(`export function ${icon}\\(`), `缺 ${icon}`);
    }
    assert.match(actions, /<IconCopy/);
    assert.match(actions, /<IconRetry/);
  });

  it('不再渲染"编辑""重发""复制"这些文字', () => {
    // 文字只该出现在 title / aria-label 里
    const jsxText = actions.replace(/title="[^"]*"/g, '').replace(/aria-label="[^"]*"/g, '');
    assert.doesNotMatch(jsxText, />\s*编辑\s*</);
    assert.doesNotMatch(jsxText, />\s*重发\s*</);
    assert.doesNotMatch(jsxText, />\s*复制\s*</);
  });

  it('有复制成功后的对勾反馈', () => {
    assert.match(actions, /copied \? <IconCheck/);
  });

  it('**没有点赞/点踩**（没有后端可接收，纯装饰）', () => {
    assert.doesNotMatch(actions, /IconThumbUp|IconThumbDown/);
    assert.doesNotMatch(actions, /aria-pressed/);
  });
});

describe('**按钮尺寸和布局照 DSH**', () => {
  it('26×26 的方形按钮', () => {
    const body = rule('.msg-action-btn');
    assert.match(body, /width:\s*26px/);
    assert.match(body, /height:\s*26px/);
  });

  it('**常显，不靠悬停**', () => {
    const body = rule('.bubble-footer');
    assert.doesNotMatch(body, /opacity:\s*0;/, 'DSH 的按钮是一直显示的');
    assert.match(body, /opacity:\s*1/);
  });

  it('不用绝对定位（DSH 是正常文档流，但不占额外行高）', () => {
    const body = rule('.bubble-footer');
    assert.match(body, /margin-top:\s*var\(--g-1\)/, '用很小的上边距贴合内容');
  });

  it('间距紧凑（0.5px 级）', () => {
    assert.match(rule('.msg-actions'), /gap:\s*var\(--g-05\)/);
  });

  it('用户消息的按钮右对齐', () => {
    assert.match(cleanCss, /\.message\.user \.bubble-footer[\s\S]{0,80}justify-content:\s*flex-end/);
  });
});

describe('按钮可访问性', () => {
  it('每个按钮都有 aria-label', () => {
    const btns = [...actions.matchAll(/<button[\s\S]*?>/g)];
    assert.ok(btns.length >= 4);
    for (const b of btns) {
      assert.match(b[0], /aria-label=/, `这个按钮缺 aria-label：${b[0].slice(0, 60)}`);
    }
  });


});
