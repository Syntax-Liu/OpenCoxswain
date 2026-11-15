/**
 * 应用图标主题。
 *
 * 用户给了 6 个配色（紫罗兰是主图标）。这里只存"选了哪个"，
 * 图标本身是打进去的 SVG，不走网络、不做运行时下载。
 *
 * ## 为什么存 localStorage 而不是走后端
 *
 * 图标只影响界面渲染（和窗口图标由 Rust 侧读同一份偏好）。
 * 走一圈 HTTP 会让首屏闪一下旧图标；localStorage 同步读、立即可用。
 *
 * Rust 侧在启动时读同一个键（见 `read_icon_theme`），
 * 所以窗口和托盘图标也跟着变。
 */

export interface IconTheme {
  readonly id: string;
  readonly label: string;
}

/** 六种配色。**紫罗兰是主图标**，也是默认值。 */
export const ICON_THEMES: readonly IconTheme[] = [
  { id: 'violet', label: '紫罗兰' },
  { id: 'sky', label: '晴空蓝' },
  { id: 'coral', label: '暖珊瑚' },
  { id: 'deep', label: '深空蓝' },
  { id: 'graphite', label: '石墨灰' },
  { id: 'mint', label: '薄荷青' },
];

export const DEFAULT_ICON_THEME = 'violet';

/** `localStorage` 的键名。Rust 侧读的是同一个名字。 */
export const ICON_THEME_KEY = 'opencoxswain.iconTheme';

/** 校验并归一化。任何非法值都退回默认（防止旧数据/手改坏掉）。 */
export function normalizeIconTheme(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ICON_THEME;
  return ICON_THEMES.some((t) => t.id === value) ? value : DEFAULT_ICON_THEME;
}

export function readIconTheme(): string {
  try {
    return normalizeIconTheme(localStorage.getItem(ICON_THEME_KEY));
  } catch {
    return DEFAULT_ICON_THEME;
  }
}

export function writeIconTheme(id: string): string {
  const next = normalizeIconTheme(id);
  try {
    localStorage.setItem(ICON_THEME_KEY, next);
  } catch {
    // 存不进去不影响当前会话，返回 next 让界面先更新
  }
  return next;
}
