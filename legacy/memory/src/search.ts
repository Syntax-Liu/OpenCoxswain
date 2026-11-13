import type { MemoryEntry, MemoryMatch, MemoryKind } from '@opencoxswain/shared';
import { tokenize } from './tokenize.js';

const KIND_BOOST: Record<MemoryKind, number> = {
  profile: 1,
  project: 1,
  decision: 1.15,
  lesson: 1.1,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_DAYS = 90;

/** 命中的查询 token；用于解释「为什么参考了这条记忆」。 */
export function matchedTokens(text: string, tokens: string[]): string[] {
  const haystack = text.toLowerCase();
  return tokens.filter((token) => haystack.includes(token));
}

/**
 * 混合评分：关键词覆盖率 65% + 时间衰减 35%，再按类型加权。
 * 纯函数，便于单测；不做 embedding。
 */
export function scoreEntry(
  entry: MemoryEntry,
  tokens: string[],
  now: number,
): MemoryMatch | null {
  if (tokens.length === 0) return null;
  const matched = matchedTokens(entry.text, tokens);
  if (matched.length === 0) return null;
  const overlap = matched.length / tokens.length;
  const ageDays = Math.max(0, now - entry.updatedAt) / DAY_MS;
  const recency = Math.exp(-ageDays / DECAY_DAYS);
  const score = (overlap * 0.65 + recency * 0.35) * KIND_BOOST[entry.kind];
  return {
    entry,
    score,
    matched,
    reason: `命中「${matched.join('、')}」，更新于 ${Math.floor(ageDays)} 天前`,
  };
}

export function rankEntries(
  entries: MemoryEntry[],
  query: string,
  now: number,
  limit: number,
): MemoryMatch[] {
  const tokens = tokenize(query);
  return entries
    .map((entry) => scoreEntry(entry, tokens, now))
    .filter((match): match is MemoryMatch => match !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
