/**
 * 应用图标配色（壳层要读的那份）。
 *
 * ## 为什么要单独存一份
 *
 * 界面里的选择已经存在 localStorage，但**壳层（Rust）读不到**：
 * 窗口和托盘图标是 Tauri 建的，不是网页画的。
 *
 * 壳层能做的只有两件事：读文件、发 HTTP。所以这里落一个小 JSON：
 *
 * ```
 * ~/.opencoxswain/icon-theme.json   { "theme": "violet" }
 * ```
 *
 * 界面切换时 POST 一次，运行时写盘；壳层启动时读。
 *
 * ## 为什么不用 localStorage 同步
 *
 * WebView 的 localStorage 是 Chromium 的 LevelDB，格式随版本变，
 * 从 Rust 侧解析等于把实现细节焊死。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 和界面保持一致：紫罗兰是主图标。 */
export const DEFAULT_ICON_THEME = 'violet';

export const ICON_THEME_IDS = ['violet', 'sky', 'coral', 'deep', 'graphite', 'mint'] as const;

export function normalizeIconTheme(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ICON_THEME;
  return (ICON_THEME_IDS as readonly string[]).includes(value) ? value : DEFAULT_ICON_THEME;
}

export interface IconThemeStoreLike {
  load(): Promise<string>;
  save(theme: string): Promise<void>;
}

/** 内存实现（测试用 / 没配路径时）。 */
export class MemoryIconThemeStore implements IconThemeStoreLike {
  private current = DEFAULT_ICON_THEME;

  async load(): Promise<string> {
    return this.current;
  }

  async save(theme: string): Promise<void> {
    this.current = normalizeIconTheme(theme);
  }
}

/** 落盘实现。 */
export class IconThemeStore implements IconThemeStoreLike {
  constructor(private readonly file: string) {}

  async load(): Promise<string> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { theme?: unknown };
      return normalizeIconTheme(raw.theme);
    } catch {
      // 文件不存在 / 坏了：用默认，不要让启动失败
      return DEFAULT_ICON_THEME;
    }
  }

  async save(theme: string): Promise<void> {
    const next = normalizeIconTheme(theme);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify({ theme: next }, null, 2)}\n`, 'utf8');
  }
}

export function defaultIconThemeFile(home: string): string {
  return path.join(home, '.opencoxswain', 'icon-theme.json');
}
