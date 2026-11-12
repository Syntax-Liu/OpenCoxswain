/**
 * 会话全文搜索。
 *
 * ## 搜什么
 *
 * 用户的问题通常是「我上次让它改登录页是哪个会话」——
 * 所以要搜的是**消息内容**，不只是会话标题。
 *
 * ## 为什么不用 FTS5
 *
 * SQLite 的 FTS5 可用，但当前数据量是几百条消息、十几万字符。
 * `LIKE` 直接扫就够快（毫秒级），而 FTS5 要：
 * - 建一张虚拟表和触发器保持同步
 * - 多一次 schema 迁移
 * - 分词对中文效果不好（除非配 unicode61 + 额外配置）
 *
 * **先用简单方案，等数据量真的上来了再换**。这是可以后面替换的实现细节，
 * 不值得为它提前付复杂度。
 *
 * ## 匹配规则
 *
 * 不区分大小写；多个词用空格分开时**要求全部命中**（AND 语义）——
 * 搜「登录 测试」应该出来同时提到两者的会话。
 */

/** 一条搜索结果。 */
export interface SearchHit {
  /** 消息 id。 */
  readonly messageId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: string;
  /** 消息原文（可能被截断）。 */
  readonly content: string;
  /** 命中位置附近的片段，用于显示"为什么这条匹配了"。 */
  readonly snippet: string;
  readonly at: number;
}

/** 摘要片段的长度（前后各留多少字）。 */
const SNIPPET_RADIUS = 60;

/**
 * 把查询切成词。
 *
 * 英文按空白切；中文整段当一个词（不分词，靠 LIKE 子串匹配）。
 * 这样「登录页」会作为整体去匹配，不会拆成「登」「录」「页」。
 */
export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** 文本是否包含所有词。 */
export function matchesAll(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const lower = text.toLowerCase();
  return tokens.every((t) => lower.includes(t));
}

/**
 * 生成命中片段。
 *
 * 取**第一个命中词**的位置，向前后各留一段。
 * 让人一眼看出"为什么这条被搜到"。
 */
export function makeSnippet(text: string, tokens: readonly string[], radius = SNIPPET_RADIUS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';

  const lower = flat.toLowerCase();
  let hit = -1;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at >= 0 && (hit < 0 || at < hit)) hit = at;
  }

  if (hit < 0) return flat.slice(0, radius * 2);

  const start = Math.max(0, hit - radius);
  const end = Math.min(flat.length, hit + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

/** 在内存里对一批消息做搜索（测试与 MemoryStore 用）。 */
export interface SearchableMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly role: string;
  readonly content: string;
  readonly at: number;
}

export function searchMessages(
  messages: readonly SearchableMessage[],
  query: string,
  options: { readonly limit?: number; readonly projectId?: string } = {},
): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const limit = options.limit ?? 50;
  const hits: SearchHit[] = [];

  for (const message of messages) {
    if (options.projectId && message.projectId !== options.projectId) continue;
    if (!matchesAll(message.content, tokens)) continue;

    hits.push({
      messageId: message.id,
      sessionId: message.sessionId,
      projectId: message.projectId,
      role: message.role,
      content: message.content.slice(0, 2000),
      snippet: makeSnippet(message.content, tokens),
      at: message.at,
    });
  }

  // 新的排前面：用户通常找最近发生的事
  hits.sort((a, b) => b.at - a.at);
  return hits.slice(0, limit);
}
