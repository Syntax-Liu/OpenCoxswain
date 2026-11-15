/**
 * 应用图标（新配色）。
 *
 * ## 为什么不用 `<img src>`
 *
 * 图标要跟着字号缩放，`<img>` 里的 SVG 不会被页面 CSS 影响；
 * 而且每次换配色都要重新发一次请求。这里把 SVG **内联**进 DOM，
 * 一份内容渲染在所有用到的地方。
 *
 * ## 为什么 id 要带主题前缀
 *
 * 六个 SVG 里都有 `id="shell"` / `id="eye"` / `id="catEar"`。
 * 内联后如果同页出现两个图标（比如设置页的预览 + 侧栏），
 * 后出现的 defs 会覆盖前面的，**颜色会串**。
 * 所以生成文件时已经把它们改成了 `oc-<theme>-shell` 这种。
 */
import { useMemo } from 'react';

import coralSvg from '../assets/icons/coral.svg?raw';
import deepSvg from '../assets/icons/deep.svg?raw';
import graphiteSvg from '../assets/icons/graphite.svg?raw';
import mintSvg from '../assets/icons/mint.svg?raw';
import skySvg from '../assets/icons/sky.svg?raw';
import violetSvg from '../assets/icons/violet.svg?raw';
import { DEFAULT_ICON_THEME, normalizeIconTheme } from '../iconTheme.js';

const SVG_BY_THEME: Record<string, string> = {
  violet: violetSvg,
  sky: skySvg,
  coral: coralSvg,
  deep: deepSvg,
  graphite: graphiteSvg,
  mint: mintSvg,
};

export interface AppIconProps {
  /** 显示尺寸（宽高相等）。 */
  readonly size?: number;
  readonly className?: string;
  /** 配色 id；不传就用紫罗兰。 */
  readonly theme?: string;
}

/**
 * 渲染应用图标。
 *
 * 内联 SVG，所以可以用 CSS 的 width/height 缩放，
 * 边缘始终清爽（位图放大会糊）。
 */
export function AppIcon({ size = 20, className, theme }: AppIconProps): JSX.Element {
  const id = normalizeIconTheme(theme ?? DEFAULT_ICON_THEME);
  const markup = useMemo(() => {
    const raw = SVG_BY_THEME[id] ?? SVG_BY_THEME[DEFAULT_ICON_THEME] ?? '';
    // 去掉 XML 声明和注释，并强制尺寸由外层控制
    return raw
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/width="512"\s+height="512"/, '')
      .replace(/<svg /, `<svg width="${size}" height="${size}" `);
  }, [id, size]);

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: size, height: size, flex: 'none' }}
      aria-hidden="true"
      // SVG 是我们自己打包进去的静态资源，不含外部输入。
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
