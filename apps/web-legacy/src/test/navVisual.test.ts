/**
 * 侧栏导航项的视觉规格。
 *
 * 用户反馈：「左侧的"新会话""Supervisor"太细太小了，而且图标偏上」。
 *
 * ## 依据（来自 ui-ux-pro-max 技能）
 *
 * **Font Size Scale**（Typography / All）：
 *   Do:   Use consistent modular scale
 *   Good: Type scale (12 14 16 18 24 32)
 *   Bad:  Random font sizes
 *
 * ## 诊断
 *
 * 原来：14px / 字重 400 / 高 22px / 图标 14×16（被 flex 压扁）。
 *
 * 实测图标与文字**中线差 0px**——"偏上"是**视觉重量的错觉**：
 * 1.5px 描边的图标比 14px/400 的文字更粗更亮，重心看着就高。
 *
 * 解法不是"往下推图标"，而是把文字加到和图标匹配的分量：
 * 16px（模块化尺度里的一档）+ 字重 500。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

function rule(selector: string): string {
  // 取**最后一条**同名规则（后面的会覆盖前面的）
  const all = [...css.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))];
  return all.length > 0 ? (all[all.length - 1]![1] ?? '') : '';
}

/** 取所有同名规则合并后的文本（用于"有没有被别处覆盖"的检查）。 */
function allRules(selector: string): string {
  return [...css.matchAll(new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, 'gm'))]
    .map((m) => m[1] ?? '')
    .join('\n');
}

describe('**导航项要够醒目**', () => {
  it('字号用 16px 档（--fs-md）', () => {
    const r = allRules('.nav-item');
    assert.match(r, /font-size:\s*var\(--fs-md\)/, '导航项字号应该是 --fs-md（16px）');
  });

  it('字重 500（太细会显得比图标轻）', () => {
    const r = allRules('.nav-item');
    assert.match(r, /font-weight:\s*500/);
  });

  it('行高 30px（给 16px 字留呼吸）', () => {
    assert.match(allRules('.nav-item'), /height:\s*30px/);
  });

  it('**图标不被压缩**（之前渲染成 14×16）', () => {
    const r = rule('.nav-icon');
    assert.match(r, /flex:\s*none/);
    assert.match(r, /width:\s*20px/);
    assert.match(r, /height:\s*20px/);
  });
});

describe('**分层：导航项 16px，项目/会话 14px**', () => {
  // **必须先去掉注释**——正则 `[^{}]*` 会跨越注释内容，
  // 把注释文字当成选择器匹配（踩过）。
  const cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // 踩过：把 .nav-item 放进 `.project-folder, .thread-item, .nav-item` 的分组里，
  // 分组规则的 font-size: --fs-sm（14px）在后面，把导航项的 16px 覆盖了。
  it('分组规则里没有 .nav-item', () => {
    const grouped = [...cleanCss.matchAll(/([^{}]*\.nav-item[^{}]*)\{([^}]*)\}/gm)];
    for (const m of grouped) {
      const selectors = m[1] ?? '';
      const body = m[2] ?? '';
      // 允许多选择器里出现 .nav-item，但那组的 font-size 不能是 --fs-sm
      if (selectors.includes('.project-folder') && selectors.includes('.thread-item')) {
        assert.doesNotMatch(body, /font-size:\s*var\(--fs-sm\)/,
          `.nav-item 不该和项目/会话共用 14px 分组规则: ${selectors.trim()}`);
      }
    }
  });

  it('项目/会话仍是 14px', () => {
    const r = allRules('.thread-item');
    assert.match(r, /font-size:\s*var\(--fs-sm\)/);
  });
});

describe('icon 与文字对齐', () => {
  it('nav-icon 有明确尺寸（不靠继承）', () => {
    const r = rule('.nav-icon');
    assert.match(r, /width:\s*20px/);
    assert.match(r, /height:\s*20px/);
  });
});
