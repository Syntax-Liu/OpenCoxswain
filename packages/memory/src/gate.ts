import { MEMORY_KINDS, type MemoryCandidate } from '@opencoxswain/shared';

const MIN_LENGTH = 4;
const MAX_LENGTH = 2000;

/** 明显只对本次任务有效的指令，不应该沉淀成长期记忆。 */
const TRANSIENT = /这次|本次|临时|暂时|仅此|just this|for now|temporar/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{12,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bbearer\s+[a-z0-9._-]{16,}\b/i,
  /(api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i,
];

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 写入门槛：来源必需、长度受限、拒绝临时指令与疑似密钥。
 * 返回 null 表示可以写入，否则返回拒绝原因。
 */
export function checkCandidate(candidate: MemoryCandidate): string | null {
  const text = candidate.text?.trim() ?? '';
  if (!MEMORY_KINDS.includes(candidate.kind)) return `未知记忆类型：${candidate.kind}`;
  if (!candidate.source?.trim()) return '缺少来源，记忆必须可追溯';
  if (text.length < MIN_LENGTH) return '内容过短，不足以成为记忆';
  if (text.length > MAX_LENGTH) return `内容过长（上限 ${MAX_LENGTH} 字）`;
  if (TRANSIENT.test(text)) return '看起来是临时指令，不写入长期记忆';
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return '疑似包含密钥或凭据，拒绝写入记忆';
  }
  return null;
}
