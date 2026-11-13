/**
 * 文件快照：为"撤销"留下原始内容。
 *
 * ## 为什么需要单独一套
 *
 * 台账记录了"改了什么"，但没记"改成什么之前是什么"。
 * 没有原内容就没有撤销——这是数据基础，不是界面问题。
 *
 * ## 为什么不存数据库
 *
 * 被改的文件可能是几 MB 的日志或 JSON。塞进 SQLite 会让数据库膨胀、
 * 备份变慢，而且用户没法直接查看。文件系统更合适。
 *
 * ## 为什么不依赖 git
 *
 * 不是所有项目都在 git 里；即使是，改到未跟踪文件也恢复不了。
 * 自带快照比依赖 git 可靠。
 *
 * ## 目录结构
 *
 * ```
 * ~/.opencoxswain/snapshots/<副作用id>/<相对路径>
 * ```
 *
 * 按副作用 id 建目录——一次写操作一个快照，撤销时按 id 精确查找。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 单个快照的最大大小。超过就不存——撤销一个 100MB 的文件不现实。 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface SnapshotResult {
  /** 是否成功保存。 */
  readonly saved: boolean;
  /** 文件在快照前是否存在（撤销时用来区分"恢复"和"删除"）。 */
  readonly existed: boolean;
  /** 失败原因（saved 为 false 时）。 */
  readonly reason?: string;
}

export interface SnapshotStore {
  /**
   * 保存某个文件的当前内容。
   *
   * **必须在写入之前调用**，否则存下来的就是改之后的内容。
   */
  save(sideEffectId: string, rootPath: string, relativePath: string): Promise<SnapshotResult>;

  /** 读回快照；没有快照返回 null。 */
  load(sideEffectId: string, relativePath: string): Promise<{ existed: boolean; content: string | null } | null>;

  /** 清掉一次副作用的所有快照。 */
  clear(sideEffectId: string): Promise<void>;
}

/** 磁盘实现。 */
export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly baseDir: string) {}

  private dirFor(sideEffectId: string): string {
    // 副作用 id 来自我们自己的生成器，但仍然过一遍白名单——
    // 万一它被伪造，不能让它拼出 ../ 去写别的目录。
    const safe = sideEffectId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.baseDir, safe);
  }

  private fileFor(sideEffectId: string, relativePath: string): string {
    // 保留目录层级，但每一段都做同样的清理
    const segments = relativePath
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s && s !== '.' && s !== '..')
      .map((s) => s.replace(/[^A-Za-z0-9._-]/g, '_'));
    return path.join(this.dirFor(sideEffectId), ...segments);
  }

  async save(sideEffectId: string, rootPath: string, relativePath: string): Promise<SnapshotResult> {
    const source = path.resolve(rootPath, relativePath);

    let content: string;
    try {
      const info = await stat(source);
      // 太大的不存：撤销一个巨大的文件不现实，如实告诉调用方
      if (info.size > MAX_SNAPSHOT_BYTES) {
        return {
          saved: false,
          existed: true,
          reason: `文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)}MB，没有备份，无法撤销`,
        };
      }
      content = await readFile(source, 'utf8');
    } catch {
      // 文件本来就不存在：这是"新建"，撤销时删掉即可。
      // 记一个标记文件，免得撤销时误以为"快照丢了"。
      const target = this.fileFor(sideEffectId, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.new`, '', 'utf8');
      return { saved: true, existed: false };
    }

    const target = this.fileFor(sideEffectId, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return { saved: true, existed: true };
  }

  async load(
    sideEffectId: string,
    relativePath: string,
  ): Promise<{ existed: boolean; content: string | null } | null> {
    const target = this.fileFor(sideEffectId, relativePath);

    // 先看是不是"新建"的标记
    try {
      await stat(`${target}.new`);
      return { existed: false, content: null };
    } catch {
      /* 不是新建 */
    }

    try {
      return { existed: true, content: await readFile(target, 'utf8') };
    } catch {
      return null; // 没有快照
    }
  }

  async clear(sideEffectId: string): Promise<void> {
    await rm(this.dirFor(sideEffectId), { recursive: true, force: true });
  }
}

/** 内存实现（测试用）。 */
export class MemorySnapshotStore implements SnapshotStore {
  private readonly saved = new Map<string, { existed: boolean; content: string | null }>();

  private key(sideEffectId: string, relativePath: string): string {
    return `${sideEffectId}::${relativePath.replace(/\\/g, '/')}`;
  }

  async save(sideEffectId: string, rootPath: string, relativePath: string): Promise<SnapshotResult> {
    const source = path.resolve(rootPath, relativePath);
    try {
      const content = await readFile(source, 'utf8');
      this.saved.set(this.key(sideEffectId, relativePath), { existed: true, content });
      return { saved: true, existed: true };
    } catch {
      this.saved.set(this.key(sideEffectId, relativePath), { existed: false, content: null });
      return { saved: true, existed: false };
    }
  }

  async load(
    sideEffectId: string,
    relativePath: string,
  ): Promise<{ existed: boolean; content: string | null } | null> {
    return this.saved.get(this.key(sideEffectId, relativePath)) ?? null;
  }

  async clear(sideEffectId: string): Promise<void> {
    for (const key of [...this.saved.keys()]) {
      if (key.startsWith(`${sideEffectId}::`)) this.saved.delete(key);
    }
  }
}
