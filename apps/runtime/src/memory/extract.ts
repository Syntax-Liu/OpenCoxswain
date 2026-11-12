/**
 * 记忆自动提炼。
 *
 * 为什么需要：现在 Assistant 只在被提醒时才 `remember`，用户不主动说"记住…"
 * 就什么都沉淀不下来。TRAE 宝 的做法是 AI 自己识别有价值的偏好。
 *
 * 但自动记忆有个大风险：**它会把错误的东西沉淀成"正确的做法"**。
 * 所以这里的做法是：
 *
 * 1. **提炼出的是"候选"，不是记忆**。候选不参与检索、不进提示词，
 *    必须用户点"采纳"之后才真正写进记忆文件。
 * 2. **候选同样过写入门槛**。临时指令、模糊偏好、密钥三条硬规则照旧生效——
 *    LLM 说"这条值得记"不算数。
 * 3. **用户拒绝过的内容不再重复提出**。否则每次提炼都弹同样的东西，
 *    用户会烦到直接关掉这个功能。
 */
import type { LlmClient, ChatMessage } from '../llm/types.js';
import { chatOnce } from '../session/loop.js';
import { checkCandidate, normalizeText, type MemoryKind } from './gate.js';
import type { MarkdownMemoryStore, MemoryScope } from './store.js';

export interface Candidate {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly scope: 'global' | 'project';
}

export interface ExtractOptions {
  readonly llm: LlmClient;
  readonly transcript: readonly { readonly role: string; readonly content: string }[];
  /** 已有记忆，用于避免提出重复内容。 */
  readonly existing: readonly string[];
  /** 用户已拒绝过的正文（归一化后），不再提出。 */
  readonly dismissed?: readonly string[];
  readonly signal: AbortSignal;
}

export interface ExtractResult {
  /** 通过所有检查、可以给用户看的候选。 */
  readonly candidates: readonly Candidate[];
  /** 被门槛拦下的，带原因（用于日志与调试，不展示给用户）。 */
  readonly rejected: ReadonlyArray<{ text: string; reason: string }>;
}

const EXTRACT_PROMPT = `你在帮用户整理"值得长期记住的结论"。

从下面这段对话里，找出**下个月还有用**的内容，给出候选记忆。

## 该提出的
- 用户明确表达的偏好（"以后都用 pnpm"）
- 双方达成的决定（"这个功能不做"）
- 踩过的坑与教训（"Windows 上要用 powershell -Command"）
- 项目规则（"所有接口都要加鉴权"）

## 不该提出的
- 一次性指令（"这次先这样"）
- 模糊说法（"可能吧"、"看情况"）
- 密钥、密码、个人隐私
- 只是复述用户说过的话

## 输出格式
只输出 JSON 数组，不要别的话。没有值得记的就输出 []。
每项形如：
{"kind":"profile|project|decision|lesson","scope":"global|project","text":"一句话，能独立看懂"}

kind 说明：profile=用户偏好（一般配 scope=global），project=项目规则，
decision=已做的决定，lesson=踩过的坑。
最多 3 条，宁缺毋滥。`;

/**
 * 从对话里提炼候选记忆。
 *
 * 失败不抛异常——提炼是锦上添花，不能因为它挂了就影响主流程。
 */
export async function extractCandidates(options: ExtractOptions): Promise<ExtractResult> {
  const empty: ExtractResult = { candidates: [], rejected: [] };

  const transcriptText = options.transcript
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? '用户' : '助理'}：${m.content}`)
    .join('\n\n')
    .slice(0, 12_000);

  if (!transcriptText.trim()) return empty;

  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACT_PROMPT },
    {
      role: 'user',
      content: [
        options.existing.length > 0
          ? `已有记忆（不要重复提这些）：\n${options.existing.map((t) => `- ${t}`).join('\n')}`
          : '',
        '对话如下：',
        transcriptText,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  let raw: string;
  try {
    raw = await chatOnce(options.llm, messages, options.signal);
  } catch {
    return empty;
  }

  const parsed = parseCandidates(raw);
  const dismissed = new Set((options.dismissed ?? []).map(normalizeText));
  const existingSet = new Set(options.existing.map(normalizeText));

  const candidates: Candidate[] = [];
  const rejected: Array<{ text: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const item of parsed) {
    const normalized = normalizeText(item.text);

    // 与已有记忆重复
    if (existingSet.has(normalized)) continue;
    // 用户已经拒绝过
    if (dismissed.has(normalized)) continue;
    // 本次内重复
    if (seen.has(normalized)) continue;

    // **关键：候选同样过写入门槛。LLM 说值得记不算数。**
    const reason = checkCandidate({
      kind: item.kind,
      text: item.text,
      source: '自动提炼',
    });
    if (reason) {
      rejected.push({ text: item.text, reason });
      continue;
    }

    seen.add(normalized);
    candidates.push(item);
    if (candidates.length >= 3) break;
  }

  return { candidates, rejected };
}

/** 解析模型返回的 JSON 数组；坏了就当没提炼出东西。 */
export function parseCandidates(raw: string): Candidate[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Candidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    const kind = String(record.kind ?? '');
    const scope = String(record.scope ?? 'project');
    if (!text) continue;
    if (!['profile', 'project', 'decision', 'lesson'].includes(kind)) continue;
    out.push({
      kind: kind as MemoryKind,
      text,
      scope: scope === 'global' ? 'global' : 'project',
    });
  }
  return out;
}

/** 把采纳的候选真正写进记忆文件。 */
export async function acceptCandidate(
  memory: MarkdownMemoryStore,
  scope: MemoryScope,
  candidate: Candidate,
  source: string,
): Promise<{ ok: boolean; reason?: string }> {
  // 写入时再过一次门槛——候选可能在等待审阅期间被改过（未来支持编辑）。
  const result = await memory.write(scope, {
    kind: candidate.kind,
    text: candidate.text,
    source,
  });
  return result.ok ? { ok: true } : { ok: false, ...(result.reason ? { reason: result.reason } : {}) };
}
