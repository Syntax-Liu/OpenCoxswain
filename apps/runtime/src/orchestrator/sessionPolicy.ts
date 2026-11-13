/**
 * Agent 会话的复用策略。
 *
 * ## 问题
 *
 * 现在每个 Agent 都开**全新会话**（`sessionId: newId('d')`）。
 * 实测：12 个 Agent 用了 12 个不同会话。
 *
 * 后果是**提示缓存完全无法命中**——每个会话的前缀都不一样，
 * 模型每次都要重新处理系统提示 + 工具定义，用户为这部分重复付费。
 *
 * ## 用户的要求（原话）
 *
 * > 有 AI 来决定，开新会话还是用旧会话，如果用户要求用新会话或者旧会话，
 * > 就按照用户要求来，如果无要求，AI 自己决定
 *
 * ## 设计
 *
 * 三个决定因素，按优先级：
 *
 * 1. **用户明确要求**（最强）——"开新会话" / "接着上次"
 * 2. **上下文是否还合适**——旧会话太长时，硬塞新任务反而更贵
 * 3. **任务是否相关**——完全无关的任务复用会话，会把无关历史带进去
 *
 * ## 一个反直觉的点
 *
 * **复用会话不一定省钱。** 如果旧会话已经 8 万 token，
 * 复用它意味着每次请求都要重新读这 8 万——而缓存只能命中前缀部分。
 *
 * 所以复用的前提是：**任务相关 + 会话还没长到拖累的程度**。
 */

export type SessionChoice = 'new' | 'reuse';

export interface SessionContext {
  /** 用户是否明确指定。 */
  readonly userWants?: SessionChoice;
  /** 可复用的候选会话（按最近使用排序，最新的在前）。 */
  readonly candidates: readonly {
    readonly sessionId: string;
    readonly messageCount: number;
    /** 估算的 token 数。 */
    readonly tokens: number;
    /** 最后一次活动时间。 */
    readonly lastActiveAt: number;
    /** 那次任务的目标，用于判断相关性。 */
    readonly lastGoal: string;
    /** 那次任务是否成功结束。 */
    readonly succeeded: boolean;
  }[];
  /** 本次任务的目标。 */
  readonly goal: string;
  /** 会话长度上限：超过就不复用（塞进去反而更贵）。 */
  readonly tokenLimit?: number;
  /** 多久之前算"还热"（复用才有缓存收益）。 */
  readonly hotWindowMs?: number;
  /** 当前时间。 */
  readonly now?: number;
}

export interface SessionDecision {
  readonly choice: SessionChoice;
  /** 复用时用哪个会话；新建时为 null。 */
  readonly sessionId: string | null;
  /** **必须说清为什么**——用户和日志都要能看到。 */
  readonly reason: string;
}

/** 默认：会话超过这个 token 数就不复用了。 */
export const DEFAULT_REUSE_TOKEN_LIMIT = 30_000;

/**
 * 默认：超过这个时间没动的会话算"冷了"。
 *
 * 10 分钟偏短——用户常常隔一会儿再派第二件事，那时缓存其实还热着。
 * 放宽到 30 分钟：DeepSeek / OpenAI 的提示缓存 TTL 通常在几十分钟量级，
 * 但即使略有超出，复用长前缀**仍然比全新会话便宜**（缓存不成比例，不是全无）。
 */
export const DEFAULT_HOT_WINDOW_MS = 30 * 60_000;

/**
 * 检查用户在这句话里有没有明确要求。
 *
 * 用户说"开新会话"就别自作聪明复用；说"接着上次"就去复用。
 * **用户的明确要求高于一切判断。**
 */
export function detectUserIntent(text: string): SessionChoice | undefined {
  const t = text.trim();

  // 明确要新会话
  if (/(?:新|另开|重新开|换|新开)(?:一个|个)?(?:会话|对话|context)/.test(t)) return 'new';
  if (/从头(?:开始|来)/.test(t)) return 'new';

  // 明确要复用
  if (/(?:接着|继续|沿用|复用)(?:上次|之前|刚才|原来)/.test(t)) return 'reuse';
  if (/(?:上次|之前)(?:那个|的)(?:会话|任务)/.test(t)) return 'reuse';

  return undefined;
}

/**
 * 判断任务是否相关。
 *
 * 朴素判据：共享至少一个非停用词。
 * 不追求准确——判错了最多是"该复用没复用"，损失是缓存没命中，不是错误。
 */
export function goalsRelated(a: string, b: string): boolean {
  const stop = new Set([
    '的', '了', '和', '与', '在', '是', '把', '给', '对', '用', '一个', '这个', '那个',
    '然后', '接着', '现在', '开始', '一下', '帮我', '请', '要', '从', '到',
  ]);

  const words = (s: string): Set<string> => {
    const set = new Set<string>();
    // 中文按 2 字切，英文按单词
    const cjk = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
    for (const chunk of cjk) {
      for (let i = 0; i < chunk.length - 1; i += 1) set.add(chunk.slice(i, i + 2));
    }
    const ascii = s.toLowerCase().match(/[a-z_][a-z0-9_-]{2,}/g) ?? [];
    for (const w of ascii) set.add(w);
    for (const s of stop) set.delete(s);
    return set;
  };

  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;

  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

/**
 * 决定这次用什么会话。
 *
 * 顺序：用户要求 → 冷却检查 → 长度检查 → 相关性检查。
 */
export function decideSession(ctx: SessionContext): SessionDecision {
  // ---- 1. 用户明确要求，最高优先级 ----
  if (ctx.userWants === 'new') {
    return { choice: 'new', sessionId: null, reason: '你要求开新会话' };
  }
  if (ctx.userWants === 'reuse') {
    const target = pickCandidate(ctx);
    if (target) {
      return {
        choice: 'reuse',
        sessionId: target.sessionId,
        reason: '你要求沿用之前的会话',
      };
    }
    // 用户要复用但没有可用候选 —— 如实说明，别假装
    return { choice: 'new', sessionId: null, reason: '你要沿用之前的会话，但没有可用的' };
  }

  // ---- 2. 没有候选，只能新建 ----
  if (ctx.candidates.length === 0) {
    return { choice: 'new', sessionId: null, reason: '这是第一次派活，没有可复用的会话' };
  }

  const now = ctx.now ?? Date.now();
  const hotWindow = ctx.hotWindowMs ?? DEFAULT_HOT_WINDOW_MS;
  const tokenLimit = ctx.tokenLimit ?? DEFAULT_REUSE_TOKEN_LIMIT;

  const picked = pickCandidate(ctx);
  if (!picked) {
    return { choice: 'new', sessionId: null, reason: '没有找到合适的可复用会话' };
  }

  // ---- 3. 会话太冷：缓存多半已过期，复用没有收益 ----
  if (now - picked.lastActiveAt > hotWindow) {
    const mins = Math.round((now - picked.lastActiveAt) / 60_000);
    return {
      choice: 'new',
      sessionId: null,
      reason: `上次会话是 ${mins} 分钟前，缓存已过期，复用它反而更贵`,
    };
  }

  // ---- 4. 会话太长：塞新任务进去，每次请求都要重读 ----
  if (picked.tokens > tokenLimit) {
    return {
      choice: 'new',
      sessionId: null,
      reason: `旧会话已经 ${Math.round(picked.tokens / 1000)}k token，塞新任务反而更贵`,
    };
  }

  // ---- 5. 任务不相关：会把无关历史带进去 ----
  if (!goalsRelated(picked.lastGoal, ctx.goal)) {
    return {
      choice: 'new',
      sessionId: null,
      reason: '这次的任务和上次不是一回事，建议开新会话',
    };
  }

  // ---- 6. 可以复用 ----
  return {
    choice: 'reuse',
    sessionId: picked.sessionId,
    reason: `上次的会话还在缓存窗口内、长度合适、任务相关`,
  };
}

/** 挑一个候选：优先最近成功的、最短的。 */
function pickCandidate(ctx: SessionContext) {
  const usable = ctx.candidates.filter((c) => c.succeeded);
  if (usable.length === 0) return ctx.candidates[0] ?? null;
  return [...usable].sort((a, b) => {
    // 先比最近活跃，再比长度（短的优先）
    const dt = b.lastActiveAt - a.lastActiveAt;
    if (Math.abs(dt) > 60_000) return dt;
    return a.tokens - b.tokens;
  })[0]!;
}
