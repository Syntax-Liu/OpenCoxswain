/**
 * 记忆的类型与写入门槛。
 *
 * 这是从 legacy `packages/memory/src/gate.ts` 提炼的，规则与 TRAE 宝官方文档一致：
 *
 * > 以下信息不会被自动保存为记忆：
 * > - 一次性或临时指令。
 * > - 模糊、不确定的偏好。
 * > - 敏感信息（如密码、个人隐私）。
 *
 * 为什么要有门槛而不是"让模型自己判断"：记忆是长期事实，一旦写进去，
 * 后续每一轮提示词都会带着它。一条"这次先用 axios"漏进去，会污染之后所有决策。
 */

/** 记忆分类。`profile` 是用户级偏好，`project` 是项目规则，`decision` / `lesson` 是跨会话结论。 */
export const MEMORY_KINDS = ['profile', 'project', 'decision', 'lesson'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  /** 记忆正文，一句话。 */
  readonly text: string;
  /** 来源：哪次对话/哪个执行者，必须可追溯。 */
  readonly source: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 待写入的候选记忆。 */
export interface MemoryCandidate {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly source: string;
}

const MIN_LENGTH = 4;
const MAX_LENGTH = 2000;

/** 明显只对本次任务有效的指令，不应沉淀成长期记忆。 */
const TRANSIENT = /这次|本次|临时|暂时|仅此|just this|for now|temporar/i;

/**
 * 模糊、不确定的表述。TRAE 宝明确不保存"模糊、不确定的偏好"。
 *
 * 注意这里只抓**明显没有结论**的表述，避免把"我倾向于用 pnpm"
 * 这种其实很确定的偏好误杀。
 */
const VAGUE = /^(可能|也许|或许|大概|不确定|随便|都行|看情况|maybe|not sure|whatever)/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[a-z0-9]{12,}\b/i,
  /\bghp_[a-z0-9]{20,}\b/i,
  /\bbearer\s+[a-z0-9._-]{16,}\b/i,
  /(api[_-]?key|token|password|secret|密码|密钥)\s*[:=：]\s*\S{8,}/i,
];

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 写入门槛：来源必需、长度受限、拒绝临时指令、模糊偏好与疑似密钥。
 *
 * @returns `null` 表示可以写入；否则返回**可读的拒绝原因**（要展示给用户/模型）。
 */
export function checkCandidate(candidate: MemoryCandidate): string | null {
  const text = candidate.text?.trim() ?? '';
  if (!MEMORY_KINDS.includes(candidate.kind)) {
    return `未知记忆类型：${String(candidate.kind)}`;
  }
  if (!candidate.source?.trim()) {
    return '缺少来源，记忆必须可追溯（哪次对话或哪个执行者得出的）';
  }
  if (text.length < MIN_LENGTH) {
    return '内容过短，不足以成为记忆';
  }
  if (text.length > MAX_LENGTH) {
    return `内容过长（上限 ${MAX_LENGTH} 字）`;
  }
  if (TRANSIENT.test(text)) {
    return '看起来是临时指令，不写入长期记忆';
  }
  // 单句且是"可能/也许/随便"这类开头 → 模糊偏好
  if (text.length <= 40 && VAGUE.test(text)) {
    return '内容过于模糊，不适合作为长期记忆（请给出确定的偏好）';
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return '疑似包含密钥或凭据，拒绝写入记忆';
    }
  }
  return null;
}
