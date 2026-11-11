/**
 * 更新检查结果的传递通道。
 *
 * 为什么要这个奇怪的中间层：
 *
 * 界面是通过 `http://127.0.0.1:PORT` 加载的（**不是** Tauri 的本地协议），
 * 所以它**拿不到 Tauri IPC**、调不到 Rust command。
 *
 * 两种选择：
 * 1. 把窗口改成 `tauri://localhost` 并能访问远程 —— 要动整个加载链路，风险大；
 * 2. 壳把检查结果落成 JSON 文件，运行时读出来透给界面 —— 风险小，界面无感。
 *
 * 这里选 2。代价是：更新检查要由壳触发（启动时或用户点按钮），
 * 而不是界面直接发起。对用户来说没有区别。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface UpdateCheck {
  /** 是否有可用更新。 */
  readonly available: boolean;
  readonly version?: string;
  readonly notes?: string;
  readonly currentVersion: string;
  readonly checkedAt: number;
}

/**
 * 定位壳写下的文件。
 *
 * Tauri 的 `app_config_dir()` 在 Windows 上是 `%APPDATA%/<identifier>`，
 * identifier 取自 tauri.conf.json（`com.opencoxswain.desktop`）。
 */
export function updateFilePath(): string {
  const appData =
    process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming');
  return path.join(appData, 'com.opencoxswain.desktop', 'update-check.json');
}

/**
 * 读更新信息。
 *
 * 读不到就返回 null —— 绝大多数用户根本没点过"检查更新"，
 * 这不是错误，界面据此显示"未知"而不是报错。
 */
export async function readUpdateCheck(file = updateFilePath()): Promise<UpdateCheck | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<UpdateCheck>;
    if (typeof raw.currentVersion !== 'string') return null;
    return {
      available: raw.available === true,
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
      ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
      currentVersion: raw.currentVersion,
      checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : 0,
    };
  } catch {
    return null;
  }
}

/** 比较两个语义化版本；a > b 返回正数，相等返回 0。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 更新说明里最值得先看的一行，用于紧凑显示。 */
export function summaryLine(check: UpdateCheck): string {
  if (check.available) {
    return `有新版本 ${check.version ?? '（未标注）'}（当前 ${check.currentVersion}）`;
  }
  return `已是最新版本（${check.currentVersion}）`;
}
