/**
 * 权限档位 —— **按项目独立存储**。
 *
 * ## 用户反馈
 *
 * > 每个项目都要有独立的权限设置，在一个项目改变权限设置，
 * > 只改变当前项目的设置，不影响其他的项目
 *
 * ## 改了什么
 *
 * 之前 `PermissionSettings` 只有一个全局 `level`，
 * 改一次全平台生效——在 A 项目放行「完全权限」，B 项目也跟着放行了。
 *
 * 现在：
 *
 *     { "level": "manual",              ← 全局默认（新项目的初始值）
 *       "projects": {                   ← 每个项目的覆盖
 *         "proj_abc": "readonly",
 *         "proj_def": "full"
 *       } }
 *
 * 读的时候先看项目覆盖，没有再退回全局默认。
 *
 * ## 一条不能松的底线（不变）
 *
 * `auto` 和 `full` **仍然记录副作用台账**。放行的是"要不要问你"，
 * 不是"要不要留痕"。写域互斥、跨项目冲突、用量止损任何档位都不能关。
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
  auto: '可以改文件，危险动作自动放行，但全部记进副作用台账。',
  full: '一切放行。仍然记录台账，写域互斥与用量止损照旧生效。',
};

/** 某一档位下，某个动作要不要问用户。 */
export function needsApproval(level: PermissionLevel, category: DangerousCategory): boolean {
  switch (level) {
    case 'readonly':
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

export function accessFor(level: PermissionLevel): 'readonly' | 'readwrite' {
  return allowsWrite(level) ? 'readwrite' : 'readonly';
}

/** 解析用户输入，非法值退回默认（manual）。 */
export function parseLevel(value: unknown): PermissionLevel {
  return PERMISSION_LEVELS.includes(value as PermissionLevel)
    ? (value as PermissionLevel)
    : 'manual';
}

export function isPermissive(level: PermissionLevel): boolean {
  return level === 'auto' || level === 'full';
}

export interface PermissionSettings {
  /** 全局默认档位（新项目从这里开始）。 */
  readonly level: PermissionLevel;
  /**
   * 每个项目的**覆盖**。
   *
   * 项目不在表里 = 用全局默认。这样改全局默认时，
   * 没单独设过的项目自动跟随，设过的不受影响。
   */
  readonly projects: Readonly<Record<string, PermissionLevel>>;
}

export const DEFAULT_PERMISSION: PermissionSettings = { level: 'manual', projects: {} };

/**
 * 取某个项目**实际生效**的档位。
 *
 * @param settings 存储的设置
 * @param projectId 项目 id；不传（比如还没进项目）就返回全局默认
 */
export function levelForProject(
  settings: PermissionSettings,
  projectId?: string | null,
): PermissionLevel {
  if (!projectId) return settings.level;
  return settings.projects[projectId] ?? settings.level;
}

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
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as {
        level?: unknown;
        projects?: unknown;
      };
      const projects: Record<string, PermissionLevel> = {};
      if (raw.projects && typeof raw.projects === 'object') {
        for (const [id, v] of Object.entries(raw.projects as Record<string, unknown>)) {
          // 只认合法的档位名，脏数据直接丢掉
          if (PERMISSION_LEVELS.includes(v as PermissionLevel)) {
            projects[id] = v as PermissionLevel;
          }
        }
      }
      return { level: parseLevel(raw.level), projects };
    } catch {
      return DEFAULT_PERMISSION;
    }
  }

  async save(settings: PermissionSettings): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    await mkdir(path.dirname(this.file), { recursive: true });
    const projects: Record<string, string> = {};
    for (const [id, v] of Object.entries(settings.projects)) {
      projects[id] = parseLevel(v);
    }
    await writeFile(
      this.file,
      `${JSON.stringify({ level: parseLevel(settings.level), projects }, null, 2)}\n`,
      'utf8',
    );
  }
}
