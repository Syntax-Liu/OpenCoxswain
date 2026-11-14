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
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

/** 取某选择器第一处规则体。 */
function rule(selector: string): string {
  const m = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  return m?.[1] ?? '';
}

describe('**行高对齐 DSH**', () => {
  it('导航行 22px', () => {
    assert.match(rule('.nav-item'), /height:\s*22px/);
  });

  it('**项目行 34px**（文字只有 20px，剩下是留白）', () => {
    assert.match(rule('.project-folder'), /height:\s*34px/);
  });

  it('**会话行 32px**（同理）', () => {
    assert.match(rule('.thread-item'), /height:\s*32px/);
  });

  it('行高比文字高度大——这是"宽松感"的来源', () => {
    const projectH = parseInt(/height:\s*(\d+)px/.exec(rule('.project-folder'))?.[1] ?? '0', 10);
    const threadH = parseInt(/height:\s*(\d+)px/.exec(rule('.thread-item'))?.[1] ?? '0', 10);
    // 文字是 20px（14px 字号 × 1.4 行高）
    assert.ok(projectH >= 30, `项目行高 ${projectH}px 太矮，看起来会挤`);
    assert.ok(threadH >= 30, `会话行高 ${threadH}px 太矮`);
  });
});

describe('主区间距', () => {
  it('消息之间 16px', () => {
    const m = /^\.messages\s*\{([^}]*)\}/m.exec(css);
    assert.match(m?.[1] ?? '', /gap:\s*var\(--g-4\)/);
  });

  it('消息区四周 16px', () => {
    const m = /^\.messages\s*\{([^}]*)\}/m.exec(css);
    assert.match(m?.[1] ?? '', /padding:\s*var\(--g-4\)/);
  });

  it('气泡内边距用 10/12', () => {
    const m = /^\.bubble\s*\{([^}]*)\}/m.exec(css);
    assert.match(m?.[1] ?? '', /padding:\s*var\(--g-25\) var\(--g-3\)/);
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
