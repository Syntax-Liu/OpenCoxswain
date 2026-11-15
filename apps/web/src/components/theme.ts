/**
 * 主题（暗色 / 亮色）。
 *
 * ## 为什么这样实现
 *
 * 令牌体系是**两层**：
 *
 *     --c-neutral-950       原始色板（唯一写十六进制的层）
 *     --color-surface-canvas: var(--c-neutral-950)   语义层
 *
 * 所以切换主题**只需要覆盖原始色板**——
 * `<html data-theme="light">` 下重新定义 `--c-*`，
 * 语义层和所有组件规则自动跟随。
 *
 * 这和字号缩放的思路一样：改一个源头，全站生效。
 * 如果直接改组件里的颜色，就会漏、就会不一致。
 */

export type Theme = 'dark' | 'light';

export interface ThemeOption {
  readonly id: Theme;
  readonly label: string;
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'dark', label: '暗色' },
  { id: 'light', label: '亮色' },
];

/**
 * 默认主题：**暗色**。
 *
 * 产品最初的定位是"夜幕指挥台"，暗色是它的本色。
 * 亮色是新加的选项，给白天/明亮环境用。
 */
export const DEFAULT_THEME: Theme = 'dark';

export const THEME_STORAGE_KEY = 'opencoxswain:theme';

/** 解析存储值，非法值退回默认。 */
export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME;
}

/**
 * 应用主题。
 *
 * 直接改 `<html>` 的 `data-theme` 属性——CSS 里靠它选择色板。
 * 用属性而不是类名：和状态标记的语义更贴近，也不容易和布局类名冲突。
 */
export function applyTheme(theme: Theme, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return;
  if (theme === 'dark') {
    // 暗色是默认值，去掉属性即可（省掉一次覆盖）
    el.removeAttribute('data-theme');
  } else {
    el.setAttribute('data-theme', theme);
  }
}
