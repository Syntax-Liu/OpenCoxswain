/**
 * 中文分词与检索排序。
 *
 * 从 legacy `packages/memory/src/tokenize.ts` / `search.ts` 原样移植：
 * - 中文按**二元组**切分（FTS 的 unicode61 分词器不切中文，这是必要的）；
 * - 排序 = 关键词覆盖率 65% + 时间衰减 35%，再按类型加权；
 * - **不做 embedding**（与 TRAE 宝一致：记忆是本地 Markdown + 人工/模型提炼，不是向量库）。
 *
 * 为什么时间衰减要有：项目规则会变，一年前的结论往往已经过时。
 * 衰减同时让"最近的同类结论"排在新旧冲突时的前面。
 */
import type { MemoryEntry, MemoryKind } from './gate.js';

export interface MemoryMatch {
  readonly entry: MemoryEntry;
  readonly score: number;
  readonly matched: readonly string[];
  readonly reason: string;
}

const CJK = /[\u3400-\u9fff]/;

/** 中文按二元组切分，西文按单词切分。 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens = new Set<string>();
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]+/g) ?? []) {
    if (!CJK.test(word)) tokens.add(word);
  }
  return [...tokens];
}

const KIND_BOOST: Record<MemoryKind, number> = {
  profile: 1,
  project: 1,
  decision: 1.15,
  lesson: 1.1,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_DAYS = 90;

/** 命中的查询 token；用于解释「为什么参考了这条记忆」。 */
export function matchedTokens(text: string, tokens: readonly string[]): string[] {
  const haystack = text.toLowerCase();
  return tokens.filter((token) => haystack.includes(token));
}

export function scoreEntry(
  entry: MemoryEntry,
  tokens: readonly string[],
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
    reason: `命中「${matched.slice(0, 4).join('、')}」，更新于 ${Math.floor(ageDays)} 天前`,
  };
}

export function rankEntries(
  entries: readonly MemoryEntry[],
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
