/**
 * 持久化：四层结构的事实库。
 *
 * 表的设计对应四个角色（方案 §5）：
 *
 * | 表 | 角色 | 一句话 |
 * | --- | --- | --- |
 * | `project` | 项目 + Assistant | 一个工作目录 + 一个常驻 Assistant 会话 |
 * | `session` | 会话 | C / Agent 的消息历史与状态 |
 * | `executor` | D | Agent，一事一 Agent，可被追问 |
 * | `turn` | 用户消息 | 留痕冲突判定与用户直连 D |
 * | `report` | Assistant 的汇报 | 每一条向用户的汇报 |
 *
 * 为什么先做内存实现：运行时骨架阶段要先把**行为**跑通并被测试钉死，
 * 换存储后端时行为不能变。接口按"读同步、写异步"设计，SQLite 后端
 * 可以直接实现同一接口（legacy 的 `node:sqlite` 用法已证明可行）。
 */
import type { AgentMessage, ChatMessage } from '../llm/types.js';
import type { CostLedger, TokenGuard } from '../cost/budget.js';
import type { AcceptancePolicy, AcceptanceResult, Criterion } from '../acceptance/criteria.js';
import type { SideEffectKind, SideEffectState } from '../security/side-effect.js';
import type { MemoryKind } from '../memory/gate.js';
import { EMPTY_METRICS, type RunMetrics } from '../cost/metrics.js';
import type { ContentPart } from '../llm/types.js';
import {
  searchMessages as searchMessageList,
  type SearchHit,
  type SearchableMessage,
} from '../search/fulltext.js';

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

export type ExecutorStatus = 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
export const EXECUTOR_TERMINAL: readonly ExecutorStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Agent 的文件访问形态。
 *
 * `readonly` 表示它**根本不写文件**，因此不参与写域互斥——
 * 三个只读任务可以真正并行。这一点很关键：早期版本把只读任务
 * 当成"没声明写域"，导致本该并行的任务被强行串行。
 */
export type ExecutorAccess = 'readwrite' | 'readonly';

export type TurnJudgment = 'new' | 'parallel' | 'conflict';
export type TurnSource = 'webapp' | 'im' | 'global-assistant' | 'assistant' | 'system';
export type ReportKind = 'progress' | 'blocked' | 'done' | 'failed' | 'question';

export type SessionKind = 'assistant' | 'executor' | 'global';

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  /** 归一化后的项目根目录。 */
  readonly rootPath: string;
  /** 原始路径（展示用，保留大小写）。 */
  readonly displayPath: string;
  /** Assistant 的会话 id —— 整个架构的锚点。 */
  readonly assistantSessionId: string;
  /**
   * 用量止损上限（token）。**不是计费**，是防止失控Agent烧光额度的止损线。
   */
  readonly tokenGuard?: TokenGuard;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

export interface SessionRow {
  readonly id: string;
  readonly kind: SessionKind;
  readonly projectId: string | null;
  /** Agent 的父会话（也就是 C）；C/B 为 null。 */
  readonly parentSessionId: string | null;
  readonly label: string;
  /** system prompt 快照，恢复会话时重放用。 */
  readonly systemPrompt: string;
  readonly status: 'idle' | 'running' | 'closed';
  /** D 结算后能否继续追问（取决于历史完整保留）。 */
  readonly resumable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExecutorRow {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly label: string;
  readonly goal: string;
  /** 只读还是读写。只读任务不参与写域互斥。 */
  readonly access: ExecutorAccess;
  readonly writeScope: readonly string[];
  readonly status: ExecutorStatus;
  readonly summary: string | null;
  readonly blockedReason: string | null;
  /** 运行指标（不做计费，只反映真实用量）。 */
  readonly metrics: RunMetrics;
  /** 验收标准（Assistant 派活时声明）。可能为空——空表示只由人看结论。 */
  readonly criteria: readonly Criterion[];
  /** 验收策略。默认 unverified_only。 */
  readonly policy: AcceptancePolicy;
  /** 系统复核结果。**未复核时为 null**，不要伪装成通过。 */
  readonly acceptance: AcceptanceResult | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

export interface TurnRow {
  readonly id: string;
  readonly projectId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly source: TurnSource;
  readonly executorId: string | null;
  readonly text: string;
  readonly judged: TurnJudgment | null;
  readonly at: number;
}

export interface ReportRow {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string | null;
  readonly kind: ReportKind;
  readonly body: string;
  readonly needsUser: boolean;
  readonly at: number;
  readonly ackedAt: number | null;
}

// ---------------------------------------------------------------------------
// 审批：不可逆动作执行前必须由人拍板
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRow {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string;
  /** 归一化后的动作类别（delete / push / publish / pay / external_send）。 */
  readonly category: string;
  /** 命中的具体证据，给用户看的。 */
  readonly evidence: string;
  /** 为什么危险。 */
  readonly why: string;
  /** 工具名与原始参数（用户可查看完整上下文）。 */
  readonly tool: string;
  readonly args: string;
  readonly status: ApprovalStatus;
  /** 用户填的拒绝/批准理由。 */
  readonly decidedReason: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  /** 超时时间：到点自动拒绝（不能让Agent永远挂着）。 */
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// 副作用台账：出事时回答"它到底改了什么"
// ---------------------------------------------------------------------------

export interface SideEffectRow {
  readonly id: string;
  readonly projectId: string;
  readonly executorId: string;
  readonly kind: SideEffectKind;
  /** 影响对象：文件路径 / 命令 / URL。 */
  readonly target: string;
  readonly state: SideEffectState;
  /** 是否可能被补偿（文件类可，命令与外发不可）。 */
  readonly reversible: boolean;
  /** 幂等键 sha256(executorId + tool + 归一化参数)。 */
  readonly idempotencyKey: string;
  readonly tool: string;
  /** 参数（截断存储，够审计即可）。 */
  readonly args: string;
  /** 失败原因或拒绝原因。 */
  readonly note: string | null;
  readonly createdAt: number;
  readonly settledAt: number | null;
}

// ---------------------------------------------------------------------------
// 记忆候选：提炼出来的记忆不能直接生效，必须先让人过一眼
// ---------------------------------------------------------------------------

export type CandidateStatus = 'pending' | 'accepted' | 'dismissed';

export interface MemoryCandidateRow {
  readonly id: string;
  readonly projectId: string;
  readonly kind: MemoryKind;
  readonly scope: 'global' | 'project';
  /** 记忆正文。 */
  readonly text: string;
  /** 从哪段对话提炼出来的，必须可追溯。 */
  readonly source: string;
  readonly status: CandidateStatus;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

export interface Store {
  // 项目
  putProject(row: ProjectRow): Promise<void>;

  /**
   * 把一个项目移出工作区（标记归档）。
   *
   * ## 为什么是归档而不是删除
   *
   * **磁盘上的文件一个都不动**——这是刻意的。删项目时顺手删目录是
   * 一道单向门，用户点错了就没有后悔的机会。
   *
   * 归档只是让它从列表里消失：
   * - 项目记录被标记 `archived=1`，`listProjects` 不再返回
   * - 会话、消息、轨迹、台账全部保留（出事时还能查）
   * - 唯一索引 `WHERE archived = 0` 让它以后还能重新打开同一目录
   *
   * 想知道"删掉的那次改了什么"，历史仍然在。
   */
  archiveProject(id: string): Promise<void>;
  getProject(id: string): ProjectRow | undefined;
  getProjectByPath(rootPath: string): ProjectRow | undefined;
  listProjects(): ProjectRow[];

  // 会话
  putSession(row: SessionRow): Promise<void>;
  getSession(id: string): SessionRow | undefined;
  listSessions(filter?: { projectId?: string; kind?: SessionKind }): SessionRow[];
  appendMessage(sessionId: string, message: AgentMessage): Promise<void>;
  /** 会话历史（含 system 之外的所有消息，按时间序）。 */
  messages(sessionId: string): AgentMessage[];
  /** 转成 LLM 需要的形态：system 前缀 + 历史。 */
  chatHistory(sessionId: string): ChatMessage[];

  /**
   * 全文搜索消息内容。
   *
   * 搜的是**消息正文**，不只是会话标题——用户的问题是
   * "我上次让它改登录页是哪个会话"，那只能靠内容找到。
   */
  searchMessages(query: string, options?: { readonly limit?: number; readonly projectId?: string }): SearchHit[];

  // Agent
  putExecutor(row: ExecutorRow): Promise<void>;
  getExecutor(id: string): ExecutorRow | undefined;
  listExecutors(filter?: { projectId?: string; status?: readonly ExecutorStatus[] }): ExecutorRow[];

  /**
   * 删除一条 Agent 及其会话与消息。
   *
   * **调用方必须先确认它没有在跑**——这个方法是物理删除，不可撤销。
   * 删除后它的会话锚点也没了，界面上的"打开原会话"会失效。
   */
  deleteExecutor(id: string): Promise<void>;
  /**
   * 某个项目从 `since` 起的累计成本（token 与折算美元）。
   *
   * 按Agent 的 createdAt 聚合——Agent是成本的载体，
   * 跨天运行的任务只算在开始那天（简单且可解释）。
   */
  costSince(projectId: string, since: number): CostLedger;

  // 对话轮
  appendTurn(row: TurnRow): Promise<void>;
  judgeTurn(id: string, judged: TurnJudgment): Promise<void>;
  listTurns(projectId: string, limit?: number): TurnRow[];

  // 汇报
  putReport(row: ReportRow): Promise<void>;
  listReports(filter?: { projectId?: string; needsUser?: boolean }): ReportRow[];

  // 审批
  putApproval(row: ApprovalRow): Promise<void>;
  getApproval(id: string): ApprovalRow | undefined;
  listApprovals(filter?: {
    projectId?: string;
    executorId?: string;
    status?: readonly ApprovalStatus[];
  }): ApprovalRow[];

  // 副作用台账
  putSideEffect(row: SideEffectRow): Promise<void>;
  getSideEffect(id: string): SideEffectRow | undefined;
  /** 按幂等键查，用于去重。 */
  findSideEffectByKey(executorId: string, key: string): SideEffectRow | undefined;
  listSideEffects(filter?: {
    projectId?: string;
    executorId?: string;
    state?: readonly SideEffectState[];
  }): SideEffectRow[];

  // 记忆候选
  putCandidate(row: MemoryCandidateRow): Promise<void>;
  getCandidate(id: string): MemoryCandidateRow | undefined;
  listCandidates(filter?: {
    projectId?: string;
    status?: readonly CandidateStatus[];
  }): MemoryCandidateRow[];

  /** 关停时落盘（内存实现里是空操作）。 */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

export class MemoryStore implements Store {
  private readonly projects = new Map<string, ProjectRow>();
  private readonly sessions = new Map<string, SessionRow>();
  private readonly histories = new Map<string, AgentMessage[]>();
  private readonly executors = new Map<string, ExecutorRow>();
  private readonly turns = new Map<string, TurnRow>();
  private readonly reports = new Map<string, ReportRow>();
  private readonly approvals = new Map<string, ApprovalRow>();
  private readonly sideEffects = new Map<string, SideEffectRow>();
  private readonly candidates = new Map<string, MemoryCandidateRow>();

  async putProject(row: ProjectRow): Promise<void> {
    this.projects.set(row.id, row);
  }

  /**
   * 内存后端：直接置归档标记。
   *
   * 保留记录而不是删除——和 SQLite 后端行为一致（历史仍可取）。
   */
  async archiveProject(id: string): Promise<void> {
    const row = this.projects.get(id);
    if (!row) return;
    this.projects.set(id, { ...row, archived: true, updatedAt: Date.now() });
  }
  getProject(id: string): ProjectRow | undefined {
    return this.projects.get(id);
  }
  getProjectByPath(rootPath: string): ProjectRow | undefined {
    for (const p of this.projects.values()) {
      if (p.rootPath === rootPath && !p.archived) return p;
    }
    return undefined;
  }
  listProjects(): ProjectRow[] {
    return [...this.projects.values()]
      .filter((p) => !p.archived)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async putSession(row: SessionRow): Promise<void> {
    this.sessions.set(row.id, row);
  }
  getSession(id: string): SessionRow | undefined {
    return this.sessions.get(id);
  }
  listSessions(filter: { projectId?: string; kind?: SessionKind } = {}): SessionRow[] {
    return [...this.sessions.values()]
      .filter((s) => (filter.projectId ? s.projectId === filter.projectId : true))
      .filter((s) => (filter.kind ? s.kind === filter.kind : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    const list = this.histories.get(sessionId) ?? [];
    list.push(message);
    this.histories.set(sessionId, list);
  }
  messages(sessionId: string): AgentMessage[] {
    return [...(this.histories.get(sessionId) ?? [])];
  }
  chatHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    const out: ChatMessage[] = [];
    if (session) out.push({ role: 'system', content: session.systemPrompt });
    for (const m of this.histories.get(sessionId) ?? []) {
      // 只回放对话可见的角色；tool 往返不持久化（每轮重建）。
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // 内部通知（Agent结算）保留在上下文里 —— C 需要它才能汇报；
      // 但它不是用户说的话，加上标记让模型分辨来源。
      if (m.role === 'user' && m.source.startsWith(INTERNAL_SOURCE_PREFIX)) {
        out.push({ role: 'user', content: `（系统通知，不是用户说的话）\n${m.content}` });
        continue;
      }
      // 带图片的消息：文本走 content，图片走 parts。
      // 由 toWireMessages 按模型能力决定发不发图。
      const images = m.images ?? [];
      if (images.length > 0) {
        const parts: ContentPart[] = [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...images,
        ];
        out.push({ role: m.role, content: m.content || null, parts });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  /**
   * 内存后端的全文搜索。
   *
   * 直接遍历所有会话的历史——数据量小，这个实现简单且和 SQLite 行为一致
   * 才是重点（两个后端必须可互换）。
   */
  searchMessages(
    query: string,
    options: { readonly limit?: number; readonly projectId?: string } = {},
  ): SearchHit[] {
    const flat: SearchableMessage[] = [];

    for (const [sessionId, messages] of this.histories) {
      const session = this.sessions.get(sessionId);
      const projectId = session?.projectId ?? '';
      if (!projectId) continue;

      for (const message of messages) {
        // 内部通知不进搜索结果：那是系统消息，不是用户或 Assistant 说的话
        if (message.source.startsWith(INTERNAL_SOURCE_PREFIX)) continue;
        flat.push({
          id: message.id,
          sessionId,
          projectId,
          role: message.role,
          content: message.content,
          at: message.at,
        });
      }
    }

    return searchMessageList(flat, query, options);
  }

  async putExecutor(row: ExecutorRow): Promise<void> {
    this.executors.set(row.id, row);
  }
  getExecutor(id: string): ExecutorRow | undefined {
    return this.executors.get(id);
  }
  async deleteExecutor(id: string): Promise<void> {
    const row = this.executors.get(id);
    if (!row) return;
    this.executors.delete(id);
    // 会话与消息一并清掉，避免留下孤儿数据
    this.histories.delete(row.sessionId);
    this.sessions.delete(row.sessionId);
  }
  listExecutors(
    filter: { projectId?: string; status?: readonly ExecutorStatus[] } = {},
  ): ExecutorRow[] {
    return [...this.executors.values()]
      .filter((e) => (filter.projectId ? e.projectId === filter.projectId : true))
      .filter((e) => (filter.status ? filter.status.includes(e.status) : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  costSince(projectId: string, since: number): CostLedger {
    const rows = [...this.executors.values()].filter(
      (e) => e.projectId === projectId && e.createdAt >= since,
    );
    let tokensIn = 0;
    let tokensOut = 0;
    for (const row of rows) {
      tokensIn += row.metrics.tokensIn;
      tokensOut += row.metrics.tokensOut;
    }
    return { tokensIn, tokensOut };
  }

  async appendTurn(row: TurnRow): Promise<void> {
    this.turns.set(row.id, row);
  }
  async judgeTurn(id: string, judged: TurnJudgment): Promise<void> {
    const row = this.turns.get(id);
    if (row) this.turns.set(id, { ...row, judged });
  }
  listTurns(projectId: string, limit = 100): TurnRow[] {
    return [...this.turns.values()]
      .filter((t) => t.projectId === projectId)
      .sort((a, b) => a.at - b.at)
      .slice(-limit);
  }

  async putReport(row: ReportRow): Promise<void> {
    this.reports.set(row.id, row);
  }
  listReports(filter: { projectId?: string; needsUser?: boolean } = {}): ReportRow[] {
    return [...this.reports.values()]
      .filter((r) => (filter.projectId ? r.projectId === filter.projectId : true))
      .filter((r) => (filter.needsUser ? r.needsUser : true))
      .sort((a, b) => a.at - b.at);
  }

  async putApproval(row: ApprovalRow): Promise<void> {
    this.approvals.set(row.id, row);
  }
  getApproval(id: string): ApprovalRow | undefined {
    return this.approvals.get(id);
  }
  listApprovals(
    filter: {
      projectId?: string;
      executorId?: string;
      status?: readonly ApprovalStatus[];
    } = {},
  ): ApprovalRow[] {
    return [...this.approvals.values()]
      .filter((a) => (filter.projectId ? a.projectId === filter.projectId : true))
      .filter((a) => (filter.executorId ? a.executorId === filter.executorId : true))
      .filter((a) => (filter.status ? filter.status.includes(a.status) : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // -------------------------------------------------------------------------
  // 副作用台账
  // -------------------------------------------------------------------------

  async putSideEffect(row: SideEffectRow): Promise<void> {
    this.sideEffects.set(row.id, row);
  }
  getSideEffect(id: string): SideEffectRow | undefined {
    return this.sideEffects.get(id);
  }
  findSideEffectByKey(executorId: string, key: string): SideEffectRow | undefined {
    for (const row of this.sideEffects.values()) {
      if (row.executorId === executorId && row.idempotencyKey === key) return row;
    }
    return undefined;
  }
  listSideEffects(
    filter: {
      projectId?: string;
      executorId?: string;
      state?: readonly SideEffectState[];
    } = {},
  ): SideEffectRow[] {
    return [...this.sideEffects.values()]
      .filter((r) => (filter.projectId ? r.projectId === filter.projectId : true))
      .filter((r) => (filter.executorId ? r.executorId === filter.executorId : true))
      .filter((r) => (filter.state ? filter.state.includes(r.state) : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  // -------------------------------------------------------------------------
  // 记忆候选
  // -------------------------------------------------------------------------

  async putCandidate(row: MemoryCandidateRow): Promise<void> {
    this.candidates.set(row.id, row);
  }
  getCandidate(id: string): MemoryCandidateRow | undefined {
    return this.candidates.get(id);
  }
  listCandidates(
    filter: { projectId?: string; status?: readonly CandidateStatus[] } = {},
  ): MemoryCandidateRow[] {
    return [...this.candidates.values()]
      .filter((c) => (filter.projectId ? c.projectId === filter.projectId : true))
      .filter((c) => (filter.status ? filter.status.includes(c.status) : true))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async close(): Promise<void> {    // 内存实现无副作用；SQLite 后端在这里关闭连接。
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * 内部消息的 source 前缀。
 *
 * 消息进 Assistant 的上下文，但**不进用户的对话流**——它是系统给模型的指令，
 * 不是用户说的话。界面上不该出现，历史查询时也要标出来。
 */
export const INTERNAL_SOURCE_PREFIX = 'internal:';

export function isInternalSource(source: string): boolean {
  return source.startsWith(INTERNAL_SOURCE_PREFIX);
}

/**
 * 归一化项目路径，作为"同一项目"的唯一判据。
 *
 * 注意保留盘符根目录的尾斜杠：`D:\` 归一化后必须是 `d:/` 而不是 `d:`。
 * 后者会被 Node 解析成"D 盘的当前目录"，`resolve` 出来是错的，
 * 下游文件操作会报 `EISDIR: lstat 'D:'`。
 */
export function normalizePath(input: string): string {
  const slashed = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const lowered = slashed.toLowerCase();
  // 盘符根：`d:` → `d:/`；POSIX 根 `/` 保持原样。
  if (/^[a-z]:$/.test(lowered)) return `${lowered}/`;
  if (lowered === '') return '/';
  return lowered;
}

export function isExecutorTerminal(status: ExecutorStatus): boolean {
  return EXECUTOR_TERMINAL.includes(status);
}
