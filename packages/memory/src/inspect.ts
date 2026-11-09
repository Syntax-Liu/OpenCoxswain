import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryIssue,
  type MemoryKind,
  type MemoryReport,
  type MemoryStats,
} from '@opencoxswain/shared';
import { normalizeText } from './gate.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 365;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{12,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bbearer\s+[a-z0-9._-]{16,}\b/i,
];

export function emptyStats(): MemoryStats {
  const byKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<
    MemoryKind,
    number
  >;
  return { total: 0, byKind, issues: 0, lastUsedAt: null };
}

export function statsOf(entries: MemoryEntry[], issues: number): MemoryStats {
  const byKind = Object.fromEntries(MEMORY_KINDS.map((kind) => [kind, 0])) as Record<
    MemoryKind,
    number
  >;
  let lastUsedAt: number | null = null;
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    if (entry.lastUsedAt !== null && (lastUsedAt === null || entry.lastUsedAt > lastUsedAt)) {
      lastUsedAt = entry.lastUsedAt;
    }
  }
  return { total: entries.length, byKind, issues, lastUsedAt };
}

/**
 * 记忆检查器：只报告可证实的问题，不改写记忆。
 * 冲突在写入时已被 superseded 处理，这里的 conflict 是防御性检查。
 */
export function inspectEntries(entries: MemoryEntry[], now: number): MemoryIssue[] {
  const issues: MemoryIssue[] = [];
  const seenText = new Map<string, string>();
  const seenKeys = new Map<string, string[]>();

  for (const entry of entries) {
    if (!entry.source.trim()) {
      issues.push({
        code: 'no_source',
        severity: 'warn',
        message: `记忆 ${entry.id} 缺少来源，无法追溯`,
        entryId: entry.id,
      });
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(entry.text)) {
        issues.push({
          code: 'secret_like',
          severity: 'warn',
          message: `记忆 ${entry.id} 疑似包含密钥，请删除`,
          entryId: entry.id,
        });
        break;
      }
    }
    const normalized = normalizeText(entry.text);
    const duplicate = seenText.get(normalized);
    if (duplicate) {
      issues.push({
        code: 'duplicate',
        severity: 'info',
        message: `记忆 ${entry.id} 与 ${duplicate} 内容重复`,
        entryId: entry.id,
      });
    } else {
      seenText.set(normalized, entry.id);
    }
    if (entry.key) {
      const scope = `${entry.projectId ?? 'global'}:${entry.key}`;
      seenKeys.set(scope, [...(seenKeys.get(scope) ?? []), entry.id]);
    }
    if (entry.lastUsedAt === null && now - entry.updatedAt > STALE_DAYS * DAY_MS) {
      issues.push({
        code: 'stale',
        severity: 'info',
        message: `记忆 ${entry.id} 超过一年未被使用，可考虑清理`,
        entryId: entry.id,
      });
    }
  }

  for (const [scope, ids] of seenKeys) {
    if (ids.length > 1) {
      const key = scope.split(':').slice(1).join(':');
      issues.push({
        code: 'conflict',
        severity: 'warn',
        message: `键「${key}」存在 ${ids.length} 条并行记忆：${ids.join('、')}`,
        entryId: ids[0] ?? null,
      });
    }
  }

  return issues;
}

export function reportOf(entries: MemoryEntry[], now: number): MemoryReport {
  const issues = inspectEntries(entries, now);
  return { stats: statsOf(entries, issues.length), issues };
}
