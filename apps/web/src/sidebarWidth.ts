/**
 * 侧栏宽度的持久化。
 *
 * ## 为什么要单独一个模块
 *
 * 宽度同时被两个地方使用：`App`（网格列宽）和 `Sidebar`（侧栏自身宽度）。
 * 早期两边各自初始化——App 写死 244、Sidebar 从 localStorage 读——
 * 结果重启后两者不一致：网格列压在 244，侧栏内部却是 384。
 * 表现出来就是"重启后错位，拖动一下就正常了"。
 *
 * 现在只有这一个读写入口，两边都调它。
 */

export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 420;
export const DEFAULT_SIDEBAR_WIDTH = 244;

const STORAGE_KEY = 'ocx.sidebarWidth';

/** 取 localStorage；在测试环境或禁用存储时可能不存在。 */
function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** 把任意数值夹到合法范围。 */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

/** 读上次保存的宽度；没有或非法时用默认值。 */
export function readSavedSidebarWidth(): number {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(Number(raw));
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** 保存宽度（存不了就算了，不影响使用）。 */
export function saveSidebarWidth(value: number): void {
  try {
    storage()?.setItem(STORAGE_KEY, String(clampSidebarWidth(value)));
  } catch {
    /* 无痕模式等场景下 localStorage 可能不可用 */
  }
}
