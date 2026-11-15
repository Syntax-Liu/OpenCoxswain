/**
 * 应用图标：六个配色 + 透明底 + 尺寸合理。
 *
 * ## 为什么需要这条测试
 *
 * 用户给的六个 SVG 有两处问题，肉眼在小尺寸下看不出来：
 *
 * 1. **白底矩形**：`<rect width="512" height="512" fill="#FFFFFF"/>`，
 *    在深色界面上会显示成一块白色方块。
 * 2. **四周留白过大**：图形只占画布 69%，UI 里设 size=20 时
 *    真正画出来的只有约 13px，比旁边同尺寸的图标小一圈。
 *
 * 这两点都是"代码跑得通、看起来也像'图标在那儿'"的问题，
 * 没有断言就会悄悄回来。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (p: string): string => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

const THEMES = ['violet', 'sky', 'coral', 'deep', 'graphite', 'mint'];

const themeSrc = read('iconTheme.ts');
const appIcon = read('components/AppIcon.tsx');
const setting = read('components/IconThemeSetting.tsx');
const settingsPage = read('components/SettingsPage.tsx');

describe('**六个图标都是透明底**', () => {
  for (const theme of THEMES) {
    it(`${theme} 没有白底矩形`, () => {
      const svg = read(`assets/icons/${theme}.svg`);
      // 整块画布填白就是背景板；其它 fill 是图形本身
      assert.doesNotMatch(
        svg,
        /<rect[^>]*width="512"[^>]*height="512"[^>]*fill="#FFF/i,
        `${theme}.svg 还有 512×512 的白色背景`,
      );
    });
  }
});

describe('**viewBox 已收紧**（图形占满画布）', () => {
  for (const theme of THEMES) {
    it(`${theme} 的 viewBox 不是 0 0 512 512`, () => {
      const svg = read(`assets/icons/${theme}.svg`);
      const m = /viewBox="([^"]+)"/.exec(svg);
      assert.ok(m, `${theme}.svg 没有 viewBox`);
      assert.notEqual(
        m[1],
        '0 0 512 512',
        `${theme}.svg 的 viewBox 没裁过——图形只占 69%，显示会偏小`,
      );
    });
  }
});

describe('图标配色', () => {
  it('**紫罗兰是默认**', () => {
    assert.match(themeSrc, /DEFAULT_ICON_THEME = 'violet'/);
    assert.match(themeSrc, /id: 'violet'/);
  });

  it('六个配色都在', () => {
    for (const id of THEMES) {
      assert.match(themeSrc, new RegExp(`id: '${id}'`), `缺 ${id}`);
    }
  });

  it('非法值退回默认（防止旧数据/手改坏掉）', () => {
    assert.match(themeSrc, /normalizeIconTheme/);
    assert.match(themeSrc, /THEMES\.some/);
  });

  it('AppIcon 认得所有配色', () => {
    for (const id of THEMES) {
      assert.match(appIcon, new RegExp(`${id}Svg`), `AppIcon 没导入 ${id}`);
    }
  });
});

describe('**设置里能切换**', () => {
  it('设置页渲染了选择器', () => {
    assert.match(settingsPage, /<IconThemeSetting/, '设置页没有图标选择器');
  });

  it('选择器是 radiogroup（可访问性）', () => {
    assert.match(setting, /role="radiogroup"/);
    assert.match(setting, /role="radio"/);
  });
});
