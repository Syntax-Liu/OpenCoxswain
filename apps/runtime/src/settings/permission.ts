/**
 * 权限档位。
 *
 * ## 四档（界面上的顺序，从最严到最松）
 *
 * | 档位 | 能改文件 | 危险动作 | 适用 |
 * | --- | --- | --- | --- |
 * | `readonly` 仅可查看 | ❌ | ❌ 不执行 | 调研、排查、看代码 |
 * | `manual` 手动审批 | ✅ | 每次问你 | 默认；处理陌生仓库 |
 * | `auto` 自动审批 | ✅ | 自动放行，但**留痕** | 熟悉的项目、批量小改动 |
 * | `full` 完全权限 | ✅ | 全部放行 | 你完全信任的场景 |
 *
 * ## 一条不能松的底线
 *
 * **`auto` 和 `full` 仍然记录副作用台账**。
 * 放行的是"要不要问你"，不是"要不要留痕"——
 * 出事之后必须能查清它做了什么。
 *
 * 另外 `full` 也不能绕过的是：写域互斥、跨项目冲突检测、用量止损。
 * 那三条保护的是**数据本身**（文件被覆盖、额度被烧光），
 * 不是"用户是否知情"，所以任何档位都不能关。
 */
import type { DangerousCategory } from '../security/classify.js';

export const PERMISSION_LEVELS = ['readonly', 'manual', 'auto', 'full'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const LEVEL_LABEL: Record<PermissionLevel, string> = {
  readonly: '仅可查看',
  manual: '手动审批',
  auto: '自动审批',
  full: '完全权限',
};

export const LEVEL_HINT: Record<PermissionLevel, string> = {
  readonly: '只读文件、执行查询。任何写入与危险动作都不会发生。',
  manual: '可以改文件。删除、推送、发布、付款、外发这些动作每次都要你点头。',
  auto: '可以改文件，危险动作自动放行，但**全部记进副作用台账**。',
  full: '一切放行。仍然记录台账，写域互斥与用量止损照旧生效。',
};

/** 某一档位下，某个动作要不要问用户。 */
export function needsApproval(level: PermissionLevel, category: DangerousCategory): boolean {
  switch (level) {
    case 'readonly':
      // 只读档根本不该产生危险动作；真碰到了也必须问（等于兜底）
      return true;
    case 'manual':
      return true;
    case 'auto':
    case 'full':
      return false;
  }
}

/** 某一档位下是否允许写文件。 */
export function allowsWrite(level: PermissionLevel): boolean {
  return level !== 'readonly';
}

/**
 * 某一档位下，Agent 的访问形态应该是什么。
 *
 * 只读档直接映射成 `readonly`，这样派活时就进了只读通道，
 * 不必等到工具调用才发现"它不该写"。
 */
export function accessFor(level: PermissionLevel): 'readonly' | 'readwrite' {
  return allowsWrite(level) ? 'readwrite' : 'readonly';
}

/** 解析用户输入，非法值退回默认（manual）。 */
export function parseLevel(value: unknown): PermissionLevel {
  return PERMISSION_LEVELS.includes(value as PermissionLevel)
    ? (value as PermissionLevel)
    : 'manual';
}

/** 档位是否允许"不询问"，用于界面提示。 */
export function isPermissive(level: PermissionLevel): boolean {
  return level === 'auto' || level === 'full';
}

export interface PermissionSettings {
  /** 全局默认档位。 */
  readonly level: PermissionLevel;
}

export const DEFAULT_PERMISSION: PermissionSettings = { level: 'manual' };

/** 设置文件的读写。 */
export interface PermissionStoreLike {
  load(): Promise<PermissionSettings>;
  save(settings: PermissionSettings): Promise<void>;
}

export class MemoryPermissionStore implements PermissionStoreLike {
  private current: PermissionSettings = DEFAULT_PERMISSION;

  async load(): Promise<PermissionSettings> {
    return this.current;
  }

  async save(settings: PermissionSettings): Promise<void> {
    this.current = settings;
  }
}

export class PermissionStore implements PermissionStoreLike {
  constructor(private readonly file: string) {}

  async load(): Promise<PermissionSettings> {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { level?: unknown };
      return { level: parseLevel(raw.level) };
    } catch {
      return DEFAULT_PERMISSION;
    }
  }

  async save(settings: PermissionSettings): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(
      this.file,
      `${JSON.stringify({ level: parseLevel(settings.level) }, null, 2)}\n`,
      'utf8',
    );
  }
}
