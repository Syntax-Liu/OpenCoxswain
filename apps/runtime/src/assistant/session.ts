/**
 * Assistant：一个项目一个常驻会话。
 *
 * 参照 TRAE 宝的实现（官方文档）：
 * > "项目专属 · TRAE 宝 —— 点项目栏中的某个项目，即可打开与'项目专属 · TRAE 宝'
 * >  的对话面板……可以围绕一个具体的项目工作，掌握更完整、精确的项目上下文，
 * >  拆解复杂需求，调度子任务并行推进。"
 *
 * 所以 C **不是**每次派活就新建的东西，而是：
 * - 每个项目一个 Session，长期存在；
 * - 用户消息进 Inbox，跑到下一个边界才被看到（不打断）；
 * - 它对项目的记忆 = 会话历史 + 项目记忆文件（见记忆模块）。
 */
import { Inbox } from '../inbox/inbox.js';
import type { AgentMessage, ChatMessage, ContentPart } from '../llm/types.js';
import { newId, type ProjectRow, type SessionRow, type Store } from '../store/store.js';

export interface AssistantSessionOptions {
  readonly store: Store;
  readonly project: ProjectRow;
  readonly systemPrompt: string;
}

/**
 * 一个 Assistant 的运行时句柄。
 *
 * 持有会话 id、inbox、以及"当前是否在跑"。消息历史以 Store 为准，
 * 这里只做缓存与投递，避免把状态放两处。
 */
export class AssistantSession {
  readonly inbox = new Inbox();
  private running = false;
  private abort: AbortController | null = null;
  private readonly queuedTurnWaiters: Array<() => void> = [];

  private constructor(
    readonly sessionId: string,
    readonly projectId: string,
    private readonly store: Store,
  ) {}

  /**
   * 打开（或创建）某项目的 Assistant 会话。
   *
   * 同一项目永远复用同一个 assistantSessionId —— 这是"项目的主人"
   * 能记住上下文的前提，也是整个架构的锚点。
   */
  static async open(options: AssistantSessionOptions): Promise<AssistantSession> {
    const { store, project, systemPrompt } = options;
    const existing = store.getSession(project.assistantSessionId);
    if (existing) {
      return new AssistantSession(existing.id, project.id, store);
    }

    const row: SessionRow = {
      id: project.assistantSessionId,
      kind: 'assistant',
      projectId: project.id,
      parentSessionId: null,
      label: `${project.name} 的Assistant`,
      systemPrompt,
      status: 'idle',
      resumable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.putSession(row);
    return new AssistantSession(row.id, project.id, store);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 用户对 Assistant 说一句（也可能是系统的内部通知）。**立刻返回**。
   *
   * 这正是"用户发送后 Assistant 立即回复、用户可以继续发送"的实现：
   * 投递是同步的，回复是异步产生的（通过事件流出）。
   */
  say(
    text: string,
    options: {
      target?: 'next' | 'step';
      source?: string;
      internal?: boolean;
      /** 图片附件；只在模型支持时才会真的发出去。 */
      images?: readonly ContentPart[];
    } = {},
  ): void {
    this.inbox.push(text, options);
  }

  /**
   * 记录一条消息到历史。
   *
   * `internal` 的消息（如Agent结算通知）会进 Assistant 的上下文，
   * 但 source 记为 `internal:` 前缀，界面据此不把它当用户消息显示。
   */
  async recordUser(
    text: string,
    source: string,
    internal = false,
    images?: readonly ContentPart[],
  ): Promise<void> {
    const message: AgentMessage = {
      id: newId('msg'),
      role: 'user',
      content: text,
      source: internal ? `internal:${source}` : source,
      at: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
    };
    await this.store.appendMessage(this.sessionId, message);
  }

  async recordAssistant(text: string, source = 'assistant'): Promise<void> {
    if (!text.trim()) return;
    const message: AgentMessage = {
      id: newId('msg'),
      role: 'assistant',
      content: text,
      source,
      at: Date.now(),
    };
    await this.store.appendMessage(this.sessionId, message);
  }

  /** 当前会话历史（含 system），交给循环使用。 */
  history(): ChatMessage[] {
    return this.store.chatHistory(this.sessionId);
  }

  /**
   * 标记开始/结束一轮，并暴露中止信号。
   *
   * 同一时刻只允许一轮在跑：并发跑会打乱历史顺序，也会让"冲突判定"看到
   * 半截状态。用户连发的消息会等在 inbox 里。
   */
  beginTurn(): { signal: AbortSignal; end: () => void } {
    if (this.running) {
      throw new Error(
        `Assistant ${this.sessionId} 已有一轮在跑；新消息应进 inbox 排队，而不是并行开轮。`,
      );
    }
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    return {
      signal,
      end: () => {
        this.running = false;
        this.abort = null;
        const waiters = this.queuedTurnWaiters.splice(0);
        for (const wake of waiters) wake();
      },
    };
  }

  /** 等当前这轮结束（没有在跑则立刻返回）。 */
  async whenIdle(): Promise<void> {
    if (!this.running) return;
    await new Promise<void>((resolve) => this.queuedTurnWaiters.push(resolve));
  }

  /** 用户点"停止"：中止当前轮，**保留**排队消息。 */
  stop(): void {
    this.abort?.abort();
  }
}

/**
 * 冲突判定：新需求与正在跑的 D 是什么关系。
 *
 * 由 Assistant 自己判定（它有项目上下文），插件侧提供机械兜底：
 * 写域相交就是冲突；**只读任务之间永远不冲突**。
 * 判定结果落 `turn.judged`，让"C 判错了"可审计。
 */
export function judgeConflict(input: {
  readonly claim: ScopeClaim;
  readonly active: readonly {
    readonly id: string;
    readonly label: string;
    readonly writeScope: readonly string[];
    readonly access: ExecutorAccess;
  }[];
}):
  | { readonly judged: 'new'; readonly reason: string }
  | { readonly judged: 'parallel'; readonly reason: string }
  | { readonly judged: 'conflict'; readonly reason: string; readonly withId: string } {
  const { active, claim } = input;
  if (active.length === 0) {
    return { judged: 'new', reason: '当前没有在跑的Agent' };
  }

  // 只读任务不写文件：既不会被别人覆盖，也不会覆盖别人。
  if (claim.access === 'readonly') {
    return {
      judged: 'parallel',
      reason: `这是只读任务，与在跑的 ${active.length} 个Agent无写入冲突，可并行`,
    };
  }

  for (const executor of active) {
    const other: ScopeClaim = { access: executor.access, scopes: executor.writeScope };
    if (scopesConflictLocal(claim, other)) {
      const why =
        claim.scopes.length === 0 || other.scopes.length === 0
          ? '任一方未声明写域，按冲突处理'
          : `写域相交：${other.scopes.join(', ')}`;
      return {
        judged: 'conflict',
        reason: `与Agent「${executor.label}」（${executor.id}）${why}`,
        withId: executor.id,
      };
    }
  }
  return {
    judged: 'parallel',
    reason: `与在跑的 ${active.length} 个Agent写域均不相交，可并行`,
  };
}

// 复用 gate 的判定，避免两处实现漂移。
import { scopesConflict as scopesConflictLocal, type ScopeClaim } from '../executor/gate.js';
import type { ExecutorAccess } from '../store/store.js';
export { scopesConflictLocal };
