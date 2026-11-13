import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  newId,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryMatch,
  type MemoryReport,
  type MemoryStats,
  type MemoryWriteResult,
} from '@opencoxswain/shared';
import { checkCandidate, normalizeText } from './gate.js';
import { indexBody, matchExpression, tokenize } from './tokenize.js';
import { rankEntries } from './search.js';
import { emptyStats, reportOf, statsOf } from './inspect.js';

export interface MemoryStoreOptions {
  dbPath: string;
  memoryDir: string;
  now?: () => number;
  notify?: (type: string, payload: unknown) => void;
}

interface EntryRow {
  id: string;
  project_id: string | null;
  kind: MemoryEntry['kind'];
  key: string | null;
  text: string;
  source: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  superseded_by: string | null;
}

function mapRow(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    key: row.key,
    text: row.text,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    supersededBy: row.superseded_by,
  };
}

/**
 * 记忆库：SQLite（含 FTS5 倒排索引）为唯一事实来源，
 * memoryDir 下的 Markdown 是从库中导出的可读快照，手改会被下次写入覆盖。
 */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly memoryDir: string;
  private readonly now: () => number;
  private readonly notify: (type: string, payload: unknown) => void;
  private readonly ftsEnabled: boolean;

  constructor(options: MemoryStoreOptions) {
    this.memoryDir = options.memoryDir;
    this.now = options.now ?? (() => Date.now());
    this.notify = options.notify ?? (() => undefined);
    mkdirSync(path.dirname(options.dbPath), { recursive: true });
    mkdirSync(this.memoryDir, { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        kind TEXT NOT NULL,
        key TEXT,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(project_id, kind);
    `);
    this.ftsEnabled = this.setupFts();
  }

  private setupFts(): boolean {
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(entry_id UNINDEXED, body)');
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  remember(candidate: MemoryCandidate): MemoryWriteResult {
    const rejection = checkCandidate(candidate);
    if (rejection) {
      this.notify('memory.rejected', { reason: rejection, kind: candidate.kind });
      return { action: 'rejected', reason: rejection };
    }
    const text = candidate.text.trim();
    const projectId = candidate.projectId ?? null;
    const key = candidate.key?.trim() || null;
    const at = this.now();

    const duplicate = this.activeRows(projectId).find(
      (row) => row.kind === candidate.kind && normalizeText(row.text) === normalizeText(text),
    );
    if (duplicate) {
      this.notify('memory.deduped', { id: duplicate.id });
      return { action: 'deduped', entry: mapRow(duplicate) };
    }

    let supersededId: string | undefined;
    if (key) {
      const existing = this.activeRows(projectId).find((row) => row.key === key);
      if (existing) {
        supersededId = existing.id;
        if (this.ftsEnabled) {
          this.db.prepare('DELETE FROM memory_fts WHERE entry_id = ?').run(existing.id);
        }
      }
    }

    const id = newId('mem');
    this.db
      .prepare(
        `INSERT INTO memory_entries
          (id, project_id, kind, key, text, source, created_at, updated_at, last_used_at, use_count, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
      )
      .run(id, projectId, candidate.kind, key, text, candidate.source.trim(), at, at);
    if (supersededId) {
      this.db
        .prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?')
        .run(id, supersededId);
    }
    if (this.ftsEnabled) {
      this.db.prepare('INSERT INTO memory_fts (entry_id, body) VALUES (?, ?)').run(id, indexBody(text));
    }

    const entry: MemoryEntry = {
      id,
      projectId,
      kind: candidate.kind,
      key,
      text,
      source: candidate.source.trim(),
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
      useCount: 0,
      supersededBy: null,
    };
    this.notify(supersededId ? 'memory.superseded' : 'memory.written', {
      id,
      kind: entry.kind,
      supersededId,
    });
    this.exportMarkdown(projectId);
    return supersededId
      ? { action: 'superseded', entry, supersededId }
      : { action: 'created', entry };
  }

  recall(
    query: string,
    options: { projectId?: string | null; limit?: number } = {},
  ): MemoryMatch[] {
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const now = this.now();
    const candidates = this.candidates(query, tokens, options.projectId ?? null);
    const matches = rankEntries(candidates, query, now, limit);
    const mark = this.db.prepare(
      'UPDATE memory_entries SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?',
    );
    for (const match of matches) {
      mark.run(now, match.entry.id);
      match.entry.lastUsedAt = now;
      match.entry.useCount += 1;
    }
    return matches;
  }

  /** 全库检索（含所有项目与全局），不改变使用统计。 */
  search(query: string, options: { limit?: number } = {}): MemoryMatch[] {
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const candidates = this.candidates(query, tokens, null, true);
    return rankEntries(candidates, query, this.now(), limit);
  }

  private candidates(
    query: string,
    tokens: string[],
    projectId: string | null,
    allProjects = false,
  ): MemoryEntry[] {
    if (this.ftsEnabled) {
      const expression = matchExpression(tokens);
      if (expression) {
        try {
          const base = `SELECT e.* FROM memory_fts f
               JOIN memory_entries e ON e.id = f.entry_id
               WHERE memory_fts MATCH ?
                 AND e.superseded_by IS NULL`;
          const rows = (allProjects
            ? this.db.prepare(`${base} LIMIT 200`).all(expression)
            : this.db
                .prepare(`${base} AND (e.project_id IS NULL OR e.project_id IS ?) LIMIT 200`)
                .all(expression, projectId)) as unknown as EntryRow[];
          if (rows.length > 0) return rows.map(mapRow);
        } catch {
          // FTS 查询语法异常时回退全量扫描。
        }
      }
    }
    if (allProjects) return this.allActiveRows().map(mapRow);
    return this.activeRows(projectId).map(mapRow);
  }

  private allActiveRows(): EntryRow[] {
    return this.db
      .prepare('SELECT * FROM memory_entries WHERE superseded_by IS NULL')
      .all() as unknown as EntryRow[];
  }

  private activeRows(projectId: string | null): EntryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_entries
         WHERE superseded_by IS NULL AND (project_id IS NULL OR project_id IS ?)`,
      )
      .all(projectId) as unknown as EntryRow[];
  }

  list(projectId?: string | null): MemoryEntry[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT * FROM memory_entries
             WHERE project_id = ? AND superseded_by IS NULL
             ORDER BY updated_at DESC`,
          )
          .all(projectId) as unknown as EntryRow[])
      : (this.db
          .prepare(
            `SELECT * FROM memory_entries
             WHERE project_id IS NULL AND superseded_by IS NULL
             ORDER BY updated_at DESC`,
          )
          .all() as unknown as EntryRow[]);
    return rows.map(mapRow);
  }

  remove(id: string): boolean {
    const row = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as
      | EntryRow
      | undefined;
    if (!row) return false;
    this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    if (this.ftsEnabled) this.db.prepare('DELETE FROM memory_fts WHERE entry_id = ?').run(id);
    this.notify('memory.removed', { id });
    this.exportMarkdown(row.project_id);
    return true;
  }

  report(projectId?: string | null): MemoryReport {
    const entries = this.scopedEntries(projectId ?? null);
    return reportOf(entries, this.now());
  }

  stats(projectId?: string | null): MemoryStats {
    const entries = projectId === undefined
      ? [...this.list(null), ...this.allProjectEntries()]
      : this.scopedEntries(projectId);
    if (entries.length === 0) return emptyStats();
    const report = reportOf(entries, this.now());
    return statsOf(entries, report.issues.length);
  }

  private allProjectEntries(): MemoryEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM memory_entries WHERE project_id IS NOT NULL AND superseded_by IS NULL')
      .all() as unknown as EntryRow[];
    return rows.map(mapRow);
  }

  private scopedEntries(projectId: string | null): MemoryEntry[] {
    return this.activeRows(projectId).map(mapRow);
  }

  private exportMarkdown(projectId: string | null): void {
    const entries = this.activeRows(projectId).map(mapRow);
    const root = this.memoryDir;
    const globalFiles: Array<[string, MemoryEntry['kind']]> = [
      ['user_profile.md', 'profile'],
      ['decisions.md', 'decision'],
      ['lessons.md', 'lesson'],
    ];
    if (projectId === null) {
      for (const [file, kind] of globalFiles) {
        this.writeFile(path.join(root, file), file, entries.filter((entry) => entry.kind === kind));
      }
      return;
    }
    const dir = path.join(root, 'projects', projectId);
    const files: Array<[string, MemoryEntry['kind']]> = [
      ['project_memory.md', 'project'],
      ['decisions.md', 'decision'],
      ['lessons.md', 'lesson'],
    ];
    for (const [file, kind] of files) {
      this.writeFile(path.join(dir, file), file, entries.filter((entry) => entry.kind === kind));
    }
  }

  private writeFile(filePath: string, title: string, entries: MemoryEntry[]): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const header = [
      `# ${title.replace(/\.md$/, '')}`,
      '',
      '> 此文件由 OpenCoxswain 根据记忆库自动生成，手改会在下次写入时被覆盖。',
      '',
    ];
    const body =
      entries.length === 0
        ? ['（暂无）']
        : entries.map(
            (entry) =>
              `- [${new Date(entry.createdAt).toISOString().slice(0, 10)}] ${entry.text}（来源：${entry.source}）`,
          );
    writeFileSync(filePath, [...header, ...body, ''].join('\n'), 'utf8');
  }
}
