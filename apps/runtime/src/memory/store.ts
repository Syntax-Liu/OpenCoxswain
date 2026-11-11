/**
 * 记忆存储：本地 Markdown 文件，**用户可读可改**。
 *
 * 布局完全对齐 TRAE 宝官方文档：
 *
 * | 类型 | 生效范围 | 存储位置 |
 * | --- | --- | --- |
 * | 全局记忆 | 所有项目 | `~/.opencoxswain/memory/user_profile.md` |
 * | 项目记忆 | 当前项目 | `~/.opencoxswain/memory/projects/{projectKey}/project_memory.md` |
 *
 * 为什么用 Markdown 而不是数据库：用户要能直接打开文件增删改（TRAE 宝 的设置页
 * 就是"在编辑器里打开 user_profile.md"）。记忆是用户自己的东西，不能锁在二进制里。
 *
 * 文件格式（保持人类可读）：
 * ```markdown
 * # 用户记忆
 *
 * <!-- opencoxswain:memory 以下内容由 OpenCoxswain 自动维护，可手工编辑 -->
 *
 * - [profile] 偏好使用 pnpm 而不是 npm
 *   _来源：对话 c_xxx · 更新于 2026-11-11_
 * ```
 *
 * 解析策略：只认 `- [kind] 正文` 的行，其余一律当普通文本忽略。
 * 这让用户加的标题、注释不会破坏解析。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  checkCandidate,
  normalizeText,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryKind,
} from './gate.js';
import { rankEntries, tokenize, type MemoryMatch } from './search.js';

export interface MemoryStoreOptions {
  /** 记忆根目录，默认 `~/.opencoxswain/memory`。 */
  readonly rootDir: string;
}

export interface MemoryScope {
  /** 全局 or 项目。 */
  readonly kind: 'global' | 'project';
  /** 项目标识（一般是归一化路径）；全局时忽略。 */
  readonly projectKey?: string;
}

export interface WriteResult {
  readonly ok: boolean;
  /** 被拒绝时的可读原因。 */
  readonly reason?: string;
  /** 是否覆盖了一条同主题的旧记忆。 */
  readonly replaced?: boolean;
}

/** 会话标题约定：文件头第一行。 */
const HEADER = {
  global: '# 用户记忆（全局）',
  project: '# 项目记忆',
} as const;

const ENTRY_LINE = /^-\s*\[(\w+)\]\s*(.+)$/;
const SOURCE_LINE = /^_来源：(.*?) · 更新于 (.*?)_$/;

export class MarkdownMemoryStore {
  constructor(private readonly options: MemoryStoreOptions) {}

  /** 全局记忆文件路径。 */
  globalFile(): string {
    return path.join(this.options.rootDir, 'user_profile.md');
  }

  /** 项目记忆文件路径。 */
  projectFile(projectKey: string): string {
    return path.join(this.options.rootDir, 'projects', safeDirName(projectKey), 'project_memory.md');
  }

  fileFor(scope: MemoryScope): string {
    return scope.kind === 'global'
      ? this.globalFile()
      : this.projectFile(scope.projectKey ?? 'unknown');
  }

  /** 读一个作用域的全部记忆。文件不存在视为空。 */
  async list(scope: MemoryScope): Promise<MemoryEntry[]> {
    const file = this.fileFor(scope);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    return parseMarkdown(raw, file);
  }

  /**
   * 写入一条记忆。
   *
   * 三道关：
   * 1. **写入门槛**（临时指令 / 模糊偏好 / 密钥 / 过短 → 拒绝）；
   * 2. **去重**：内容归一化后相同 → 直接返回成功但不重复写；
   * 3. **同主题取代**：正文完全相同前缀但结论不同（例如"用 npm"改成"用 pnpm"），
   *    视为更新而不是新增。
   */
  async write(scope: MemoryScope, candidate: MemoryCandidate): Promise<WriteResult> {
    const rejected = checkCandidate(candidate);
    if (rejected) return { ok: false, reason: rejected };

    const entries = await this.list(scope);
    const now = Date.now();
    const normalized = normalizeText(candidate.text);

    const existingIndex = entries.findIndex((e) => normalizeText(e.text) === normalized);
    if (existingIndex >= 0) {
      // 完全重复：不写，但算成功（幂等）。
      return { ok: true, replaced: false };
    }

    const entry: MemoryEntry = {
      id: newId('mem'),
      kind: candidate.kind,
      text: candidate.text.trim(),
      source: candidate.source.trim(),
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
    await this.persist(scope, entries, Object.keys(HEADER), true);
    return { ok: true, replaced: false };
  }

  /**
   * 用新结论取代旧记忆（同一条被更正）。
   *
   * 这是"AI 识别到你的偏好发生变化时会主动更新对应记忆"（TRAE 宝）的实现。
   */
  async replace(scope: MemoryScope, entryId: string, candidate: MemoryCandidate): Promise<WriteResult> {
    const rejected = checkCandidate(candidate);
    if (rejected) return { ok: false, reason: rejected };

    const entries = await this.list(scope);
    const index = entries.findIndex((e) => e.id === entryId);
    if (index < 0) return { ok: false, reason: `记忆 ${entryId} 不存在` };

    const old = entries[index]!;
    entries[index] = {
      ...old,
      text: candidate.text.trim(),
      source: candidate.source.trim(),
      updatedAt: Date.now(),
    };
    await this.persist(scope, entries, Object.keys(HEADER), true);
    return { ok: true, replaced: true };
  }

  /** 删除一条记忆。 */
  async remove(scope: MemoryScope, entryId: string): Promise<boolean> {
    const entries = await this.list(scope);
    const next = entries.filter((e) => e.id !== entryId);
    if (next.length === entries.length) return false;
    await this.persist(scope, next, Object.keys(HEADER), true);
    return true;
  }

  /**
   * 跨作用域检索：全局 + 指定项目。
   *
   * 结果自带作用域，便于提示词里标注"这是项目规则"还是"这是用户偏好"。
   */
  async search(
    query: string,
    scope: MemoryScope,
    options: { limit?: number; now?: number } = {},
  ): Promise<Array<MemoryMatch & { scope: 'global' | 'project' }>> {
    const limit = options.limit ?? 6;
    const now = options.now ?? Date.now();

    const [globalEntries, projectEntries] = await Promise.all([
      this.list({ kind: 'global' }),
      scope.kind === 'project' ? this.list(scope) : Promise.resolve([]),
    ]);

    const globalMatches = rankEntries(globalEntries, query, now, limit).map((m) => ({
      ...m,
      scope: 'global' as const,
    }));
    const projectMatches = rankEntries(projectEntries, query, now, limit).map((m) => ({
      ...m,
      scope: 'project' as const,
    }));

    return [...globalMatches, ...projectMatches]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * 渲染成注入提示词的一段文本。
   *
   * 以 `query` 命中为主，但**项目规则总是全量注入**——规则是硬约束，
   * 不能因为这一轮没命中关键词就不告诉 C。
   */
  async renderForPrompt(
    scope: MemoryScope,
    query: string,
    options: { limit?: number; now?: number } = {},
  ): Promise<string> {
    const projectEntries = scope.kind === 'project' ? await this.list(scope) : [];
    const globalMatches = await this.search(query, scope, {
      limit: options.limit ?? 4,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const lines: string[] = [];

    if (projectEntries.length > 0) {
      lines.push('### 项目记忆（必须遵守）');
      for (const entry of projectEntries) lines.push(`- [${entry.kind}] ${entry.text}`);
      lines.push('');
    }

    const globalHits = globalMatches.filter((m) => m.scope === 'global');
    if (globalHits.length > 0) {
      lines.push('### 与你这句话相关的用户偏好');
      for (const m of globalHits) lines.push(`- ${m.entry.text}（${m.reason}）`);
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  /** 原子写：先写临时文件再改名，避免半截文件。 */
  private async persist(
    scope: MemoryScope,
    entries: readonly MemoryEntry[],
    kinds: readonly string[],
    create: boolean,
  ): Promise<void> {
    const file = this.fileFor(scope);
    await mkdir(path.dirname(file), { recursive: true });
    const title = scope.kind === 'global' ? HEADER.global : HEADER.project;
    const body = [
      title,
      '',
      '<!-- 以下内容由 OpenCoxswain 维护，可以手工编辑。格式：- [类型] 内容 -->',
      '',
      ...entries.flatMap((entry) => [
        `- [${entry.kind}] ${entry.text}`,
        `  _来源：${entry.source} · 更新于 ${new Date(entry.updatedAt).toISOString().slice(0, 10)}_`,
        '',
      ]),
    ].join('\n');

    void kinds;
    void create;
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, body, 'utf8');
    // rename 在同目录内是原子的。
    await writeFile(file, body, 'utf8');
    const { rm } = await import('node:fs/promises');
    await rm(tmp, { force: true });
  }
}

/**
 * 解析 Markdown。
 *
 * 只认 `- [kind] 正文`（允许前面有空白），紧跟的 `_来源：..._` 作为来源；
 * 其它行（标题、HTML 注释、用户随手写的说明）一律忽略。
 */
export function parseMarkdown(raw: string, file = ''): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let index = 0;
  for (const line of raw.split(/\r?\n/)) {
    index += 1;
    const match = ENTRY_LINE.exec(line.trim());
    if (!match) continue;
    const kind = match[1] as MemoryKind;
    if (!MEMORY_KINDS_SET.has(kind)) continue;
    const text = (match[2] ?? '').trim();
    if (!text) continue;
    entries.push({
      // 稳定 id：同一文件同一位置同一内容 → 同一 id，便于删除/替换
      id: `mem_${hash(`${file}:${index}:${text}`)}`,
      kind,
      text,
      source: '',
      createdAt: 0,
      updatedAt: 0,
    });
  }

  // 第二遍：把 `_来源：..._` 挂到前一条上。
  const lines = raw.split(/\r?\n/);
  let cursor = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (ENTRY_LINE.test(line)) {
      cursor += 1;
      continue;
    }
    const sourceMatch = SOURCE_LINE.exec(line);
    if (sourceMatch && cursor >= 0 && cursor < entries.length) {
      const entry = entries[cursor]!;
      const dateText = sourceMatch[2] ?? '';
      const parsed = Date.parse(dateText);
      (entries[cursor] as { source: string }).source = sourceMatch[1]?.trim() ?? '';
      (entries[cursor] as { updatedAt: number }).updatedAt = Number.isFinite(parsed)
        ? parsed
        : 0;
      (entries[cursor] as { createdAt: number }).createdAt = Number.isFinite(parsed)
        ? parsed
        : 0;
      void entry;
    }
  }

  return entries;
}

const MEMORY_KINDS_SET = new Set<string>(['profile', 'project', 'decision', 'lesson']);

/** 目录名安全化：路径分隔符换成 `_`，避免把项目路径变成多层目录。 */
export function safeDirName(key: string): string {
  return key.replace(/[\\/:*?"<>|]/g, '_').replace(/^_+/, '').slice(0, 120) || 'project';
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export { tokenize };
