/**
 * 欢迎页大图标为什么"看起来偏上"。
 *
 * ## 用户反复说了很多次
 *
 * 我前几次都在调**位置**：
 * - 盒子中线 → 差 0px
 * - 图形在视口里居中 → 修了 IconSupervisor 6.38 → 8
 * - `top: 3px` → `4px`
 *
 * ## 真正的问题
 *
 * 实测数据：
 *
 *     中线差        0px        ← 几何上完全对齐
 *     图形高/文字高  60%       ← 但图标只有六成高
 *
 * 小图标在大字旁边，视觉重心往左上飘。
 *
 * **和导航项那个问题是同一个病**：导航项用 20px 解决了（占比 74%），
 * 欢迎页大图标还停在 28px（占比 60%），我一直没意识到。
 *
 * ## 修
 *
 *     28px → 36px（占比 60% → 77%）
 *     top 从写死的 4px 改成按字号算的 0.45em
 *
 * `top` 用 em 而不是 px：换字号时不用重新量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
const newSession = readFileSync(new URL('../../src/components/NewSession.tsx', import.meta.url), 'utf8');
const conversation = readFileSync(new URL('../../src/components/Conversation.tsx', import.meta.url), 'utf8');

function rule(selector: string): string {
  const all = [...cleanCss.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

describe('**欢迎页大图标要够大**', () => {
  it('图标 36px（不是 28px）', () => {
    assert.match(newSession, /<AppIcon size=\{36\}/);
    // Supervisor 页的欢迎页同理
    assert.doesNotMatch(newSession, /<AppIcon size=\{28\}/);
  });

  it('Supervisor 页也用 36', () => {
    assert.match(conversation, /<AppIcon size=\{36\}/);
  });

  it('**top 用相对单位**（换字号不用重新量）', () => {
    const body = rule('.welcome-brand svg');
    assert.match(body, /top:\s*0\.\d+em/, 'px 写死的话一改字号就得重调');
  });

  it('注释里记录了占比数据', () => {
    // 防止以后有人"优化"回 28px
    assert.match(css, /77%|60%/, '要留下为什么改的原因');
  });
});

describe('中线对齐（几何）', () => {
  it('用基线对齐而不是 center', () => {
    const body = rule('.welcome-brand');
    assert.match(body, /align-items:\s*baseline/);
  });
});
