/**
 * 上下文压缩。
 *
 * ## 为什么必须做
 *
 * 一个跑几十步的 Agent，每步工具返回几千 token。跑到二十几步就会
 * 超出模型上下文窗口，**整轮失败**。用户看到的是"跑到一半突然报错"。
 *
 * 这是「能不能跑长任务」的分水岭，不是优化项。
 *
 * ## 策略：分层，从便宜到贵
 *
 * 1. **工具结果剪枝**（最便宜，不调模型）
 *    把过长的工具输出做「头 + 尾」保留，中间省略。
 *    大多数溢出靠这一步就能解决。
 *
 * 2. **丢弃中间轮次**（不调模型）
 *    保留最初的用户目标 + 最近 N 条，中间整体折叠成一句说明。
 *    简单但会丢信息。
 *
 * 3. **摘要替䟰**（要调模型，最贵）
 *    把选中的历史交给模型总结成一段。
 *    本实现**先不做**——理由见下。
 *
 * ## 为什么暂不做模型摘要
 *
 * 摘要要额外调一次模型，出错时（超时、限流）会把一次正常运行变成失败，
 * 而且摘要本身的 token 成本不低。在没有真实的溢出数据之前，
 * 先用前两层解决 90% 的情况；真不够再加。
 *
 * ## 一条硬约束：配对不能破坏
 *
 * `assistant(tool_calls)` 与随后的 `tool(tool_call_id)` 必须成对。
 * 压缩边界如果把两者拆开，模型会收到"要求结果但没有调用"的畸形历史，
 * 多数服务端会直接 400。
 *
 * 所以**所有切点都必须落在"成对边界"上**，不能切在中间。
 */
import type { ChatMessage } from '../llm/types.js';

/** 触发压缩的估算 token 上限。 */
export const DEFAULT_TOKEN_LIMIT = 96_000;

/** 压缩后保留多少条最近消息。 */
export const DEFAULT_KEEP_RECENT = 12;

/** 单条工具结果最多保留多少字符（头 + 尾）。 */
export const DEFAULT_TOOL_RESULT_BUDGET = 4_000;

/**
 * 粗略估算 token。
 *
 * 不引入 tokenizer：那会破坏"零依赖"，而且不同模型的分词器还不一样。
 * 中文按 1 字 ≈ 1 token、英文按 4 字符 ≈ 1 token 的混合估算，
 * 对"判断是否接近上限"这个用途足够——我们只需要一个数量级正确的数。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 中日韩统一表意文字 + 全角标点
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 整段历史的估算 token。 */
export function estimateMessages(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? '');
    for (const call of m.tool_calls ?? []) {
      total += estimateTokens(call.function?.name ?? '');
      total += estimateTokens(call.function?.arguments ?? '');
    }
    total += 4; // 每条消息的角色标记开销
  }
  return total;
}

/** 头尾保留；中间省略。 */
export function pruneText(text: string, budget: number): { text: string; pruned: boolean } {
  if (text.length <= budget) return { text, pruned: false };
  const half = Math.floor(budget / 2);
  const head = text.slice(0, half);
  const tail = text.slice(-half);
  const omitted = text.length - budget;
  return {
    text: `${head}\n\n…（中间省略 ${omitted} 字）…\n\n${tail}`,
    pruned: true,
  };
}

export interface CompactResult {
  readonly messages: readonly ChatMessage[];
  /** 是否真的改动了。 */
  readonly changed: boolean;
  /** 剪枝了几条工具结果。 */
  readonly prunedToolResults: number;
  /** 折叠掉了几条历史消息。 */
  readonly droppedMessages: number;
  /** 压缩前后的估算 token。 */
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface CompactOptions {
  readonly tokenLimit?: number;
  readonly keepRecent?: number;
  readonly toolResultBudget?: number;
}

/**
 * 判断某个位置能不能当切点。
 *
 * 切点在 `index` 之前（即丢弃 [0, index)）。合法条件：
 * **从 index 开始不能是一个孤立的 `tool` 结果**——
 * 那意味着它的 `assistant(tool_calls)` 被我们切掉了。
 */
export function isSafeCut(messages: readonly ChatMessage[], index: number): boolean {
  // 切点在 0 = 什么都不丢，永远安全。
  if (index <= 0) return true;
  // 切到末尾 = 全丢，也安全（调用方会自己决定要不要这么干）。
  if (index >= messages.length) return true;
  return messages[index]!.role !== 'tool';
}

/** 从 index 往前找最近的合法切点。 */
export function findSafeCut(messages: readonly ChatMessage[], wanted: number): number {
  for (let i = Math.min(wanted, messages.length); i > 0; i -= 1) {
    if (isSafeCut(messages, i)) return i;
  }
  return 0;
}

/**
 * 执行压缩。
 *
 * 顺序很重要：**先剪枝（便宜、无损语义），不够再折叠**。
 * 剪枝只动工具输出的中段，模型仍能看到首尾，信息损失最小。
 */
export function compactMessages(
  messages: readonly ChatMessage[],
  options: CompactOptions = {},
): CompactResult {
  const limit = options.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const budget = options.toolResultBudget ?? DEFAULT_TOOL_RESULT_BUDGET;

  const before = estimateMessages(messages);
  let working: ChatMessage[] = [...messages];
  let prunedToolResults = 0;

  // ---- 第一层：工具结果剪枝 ----
  working = working.map((m) => {
    if (m.role !== 'tool' || !m.content) return m;
    const { text, pruned } = pruneText(m.content, budget);
    if (!pruned) return m;
    prunedToolResults += 1;
    return { ...m, content: text };
  });

  let droppedMessages = 0;

  // ---- 第二层：仍然超限时折叠中间 ----
  if (estimateMessages(working) > limit) {
    // 保留第一条（用户目标）和最近 keepRecent 条
    const headKeep = 1;
    const rawCut = Math.max(headKeep, working.length - keepRecent);
    const cut = findSafeCut(working, rawCut);

    if (cut > headKeep) {
      droppedMessages = cut - headKeep;
      const head = working.slice(0, headKeep);
      const tail = working.slice(cut);
      const notice: ChatMessage = {
        role: 'user',
        content:
          `（此前 ${droppedMessages} 条历史因为上下文过长已折叠。` +
          '如需回顾细节，请说明要看哪一段。）',
      };
      working = [...head, notice, ...tail];
    }
  }

  const changed = prunedToolResults > 0 || droppedMessages > 0;

  return {
    messages: working,
    changed,
    prunedToolResults,
    droppedMessages,
    tokensBefore: before,
    tokensAfter: estimateMessages(working),
  };
}
