/**
 * SQLite 持久化后端。
 *
 * 用 Node 内置的 `node:sqlite`（>= 22），**不需要原生模块编译**——这是
 * legacy 已验证过的选择，Windows 上尤其省事。
 *
 * 设计原则：
 * 1. **与 `MemoryStore` 实现同一个 `Store` 接口**，行为必须完全一致。
 *    切换后端不允许改变任何可观察行为（这一点由 `store.test.ts` 双后端跑同一套断言保证）。
 * 2. **写同步落盘**。Assistant 的会话历史、Agent 的结算、冲突判定都是事实，
 *    进程被强杀也不能丢——所以每个写操作都是立即提交的事务。
 * 3. **schema 版本化**。用 `PRAGMA user_version` 做迁移，老库能升级。
 *
 * 表结构对应四层结构（方案 §5）：
 *
 * | 表 | 角色 |
 * | --- | --- |
 * | `project` | 项目 + Assistant 的会话锚点 |
 * | `session` | C / Agent 的会话元数据 |
 * | `message` | 会话消息历史（"打开原会话"靠它） |
 * | `executor` | Agent 的记录 |
 * | `turn` | 用户消息与冲突判定留痕 |
 * | `report` | Assistant 的汇报 |
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { AgentMessage, ChatMessage } from '../llm/types.js';
import {
  isExecutorTerminal,
  type ApprovalRow,
  type ApprovalStatus,
  type CandidateStatus,
  type MemoryCandidateRow,
  type SideEffectRow,
  type ExecutorRow,
  type ExecutorStatus,
  type ProjectRow,
  type ReportRow,
  type SessionKind,
  type SessionRow,
  type Store,
  type TurnJudgment,
  type TurnRow,
} from './store.js';
import { INTERNAL_SOURCE_PREFIX } from './store.js';
import type { CostLedger } from '../cost/budget.js';
import type { SideEffectKind, SideEffectState } from '../security/side-effect.js';
import type { ContentPart } from '../llm/types.js';

const SCHEMA_VERSION = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  assistant_session_id TEXT NOT NULL,
  token_guard TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS project_root ON project(root_path) WHERE archived = 0;

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT,
  parent_session_id TEXT,
  label TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  resumable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_project ON session(project_id);

CREATE TABLE IF NOT EXISTS message (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  at INTEGER NOT NULL,
  -- v8：图片附件（JSON 数组）。NULL 表示没有附件。
  images TEXT
);
CREATE INDEX IF NOT EXISTS message_session ON message(session_id, seq);

CREATE TABLE IF NOT EXISTS executor (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  label TEXT NOT NULL,
  goal TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'readwrite',
  write_scope TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  blocked_reason TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  context_tokens INTEGER,
  criteria TEXT,
  policy TEXT,
  acceptance TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS executor_project ON executor(project_id);

CREATE TABLE IF NOT EXISTS turn (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  source TEXT NOT NULL,
  executor_id TEXT,
  text TEXT NOT NULL,
  judged TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS turn_project ON turn(project_id, at);

CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  executor_id TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  needs_user INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS report_project ON report(project_id, at);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  category TEXT NOT NULL,
  evidence TEXT NOT NULL,
  why TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_project ON approval(project_id, created_at);
CREATE INDEX IF NOT EXISTS approval_executor ON approval(executor_id, status);

CREATE TABLE IF NOT EXISTS side_effect (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS side_effect_executor ON side_effect(executor_id, created_at);
CREATE INDEX IF NOT EXISTS side_effect_key ON side_effect(executor_id, idempotency_key);

CREATE TABLE IF NOT EXISTS memory_candidate (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_candidate_project ON memory_candidate(project_id, status);
`;

type Row = Record<string, unknown>;

export interface SqliteStoreOptions {
  /** 数据库文件路径；传 ':memory:' 用内存库（测试用）。 */
  readonly file: string;
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    if (options.file !== ':memory:') {
      mkdirSync(path.dirname(options.file), { recursive: true });
    }
    this.db = new DatabaseSync(options.file);
    // WAL 让读写并发更友好；foreign_keys 目前没有外键约束，留着为将来。
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const version = Number(
      (this.db.prepare('PRAGMA user_version').get() as Row | undefined)?.user_version ?? 0,
    );
    if (version >= SCHEMA_VERSION) {
      // 表可能不存在但版本号对——IF NOT EXISTS 让这里安全。
      this.db.exec(SCHEMA);
      return;
    }
    this.db.exec('BEGIN;');
    try {
      this.db.exec(SCHEMA);
      // v1 → v2：executor 表新增 access 列（区分只读/读写）。
      // 老库没有这列，ALTER 补上；老数据一律视为 readwrite（保守）。
      if (version < 2 && !this.hasColumn('executor', 'access')) {
        this.db.exec(
          `ALTER TABLE executor ADD COLUMN access TEXT NOT NULL DEFAULT 'readwrite';`,
        );
      }
      // v2 → v3：运行指标（轮次/步数/token/耗时/上下文）。
      // 不做计费，只记录模型自己报告的真实数字。
      if (version < 3) {
        for (const [table, column, ddl] of [
          ['executor', 'turns', `ALTER TABLE executor ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;`],
          ['executor', 'steps', `ALTER TABLE executor ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;`],
          ['executor', 'tokens_in', `ALTER TABLE executor ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;`],
          ['executor', 'tokens_out', `ALTER TABLE executor ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;`],
          ['executor', 'cached_tokens', `ALTER TABLE executor ADD COLUMN cached_tokens INTEGER;`],
          ['executor', 'duration_ms', `ALTER TABLE executor ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;`],
          ['executor', 'context_tokens', `ALTER TABLE executor ADD COLUMN context_tokens INTEGER;`],
          ['project', 'token_guard', `ALTER TABLE project ADD COLUMN token_guard TEXT;`],
          ['executor', 'criteria', `ALTER TABLE executor ADD COLUMN criteria TEXT;`],
          ['executor', 'policy', `ALTER TABLE executor ADD COLUMN policy TEXT;`],
          ['executor', 'acceptance', `ALTER TABLE executor ADD COLUMN acceptance TEXT;`],
        ] as const) {
          if (!this.hasColumn(table, column)) this.db.exec(ddl);
        }
      }
      // v7 → v8：message 表新增 images 列（图片附件）。
      // 老库补列，老数据为 NULL（没有附件），不影响回放。
      if (version < 8 && !this.hasColumn('message', 'images')) {
        this.db.exec('ALTER TABLE message ADD COLUMN images TEXT;');
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      // v3 → v4 只是新增 approval 表，SCHEMA 里的 CREATE IF NOT EXISTS 已覆盖，
      // 无需额外 ALTER。
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return rows.some((r) => String(r.name) === column);
  }

  // -------------------------------------------------------------------------
  // 项目
  // -------------------------------------------------------------------------

  async putProject(row: ProjectRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO project (id, name, root_path, display_path, assistant_session_id, token_guard, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           display_path = excluded.display_path,
           assistant_session_id = excluded.assistant_session_id,
           token_guard = excluded.token_guard,
           updated_at = excluded.updated_at,
           archived = excluded.archived`,
      )
      .run(
        row.id,
        row.name,
        row.rootPath,
        row.displayPath,
        row.assistantSessionId,
        row.tokenGuard ? JSON.stringify(row.tokenGuard) : null,
        row.createdAt,
        row.updatedAt,
        row.archived ? 1 : 0,
      );
  }

  getProject(id: string): ProjectRow | undefined {
    const raw = this.db.prepare('SELECT * FROM project WHERE id = ?').get(id) as Row | undefined;
    return raw ? toProject(raw) : undefined;
  }

  getProjectByPath(rootPath: string): ProjectRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM project WHERE root_path = ? AND archived = 0')
      .get(rootPath) as Row | undefined;
    return raw ? toProject(raw) : undefined;
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare('SELECT * FROM project WHERE archived = 0 ORDER BY created_at ASC')
      .all() as Row[];
    return rows.map(toProject);
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  async putSession(row: SessionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session (id, kind, project_id, parent_session_id, label, system_prompt, status, resumable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           system_prompt = excluded.system_prompt,
           status = excluded.status,
           resumable = excluded.resumable,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.kind,
        row.projectId,
        row.parentSessionId,
        row.label,
        row.systemPrompt,
        row.status,
        row.resumable ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      );
  }

  getSession(id: string): SessionRow | undefined {
    const raw = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Row | undefined;
    return raw ? toSession(raw) : undefined;
  }

  listSessions(filter: { projectId?: string; kind?: SessionKind } = {}): SessionRow[] {
    const where: string[] = [];
    const params: Array<string> = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    const sql = `SELECT * FROM session${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toSession);
  }

  async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO message (session_id, id, role, content, source, at, images) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        sessionId,
        message.id,
        message.role,
        message.content,
        message.source,
        message.at,
        // 图片以 JSON 存。没有附件时存 NULL 而不是 '[]'——
        // 这样「有没有图片」只看一个列是否为空，不用解析。
        message.images && message.images.length > 0 ? JSON.stringify(message.images) : null,
      );
  }

  messages(sessionId: string): AgentMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as Row[];
    return rows.map((r) => {
      // 图片列是 JSON；解析失败（老数据或损坏）就当没有附件，不影响回放
      let images: ContentPart[] | undefined;
      if (typeof r.images === 'string' && r.images) {
        try {
          const parsed = JSON.parse(r.images) as ContentPart[];
          if (Array.isArray(parsed) && parsed.length > 0) images = parsed;
        } catch {
          /* 损坏的 JSON 忽略 */
        }
      }
      return {
        id: String(r.id),
        role: String(r.role) as AgentMessage['role'],
        content: String(r.content),
        source: String(r.source),
        at: Number(r.at),
        ...(images ? { images } : {}),
      };
    });
  }

  chatHistory(sessionId: string): ChatMessage[] {
    const session = this.getSession(sessionId);
    const out: ChatMessage[] = [];
    if (session) out.push({ role: 'system', content: session.systemPrompt });
    for (const m of this.messages(sessionId)) {
      // 只回放对话可见的角色；tool 往返不持久化（每轮重建）。
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // 内部通知保留在上下文里（C 靠它汇报），但标明来源。
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

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  async putExecutor(row: ExecutorRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO executor (id, project_id, session_id, label, goal, access, write_scope, status, summary, blocked_reason,
           turns, steps, tokens_in, tokens_out, cached_tokens, duration_ms, context_tokens, criteria, policy, acceptance, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           summary = excluded.summary,
           blocked_reason = excluded.blocked_reason,
           turns = excluded.turns,
           steps = excluded.steps,
           tokens_in = excluded.tokens_in,
           tokens_out = excluded.tokens_out,
           cached_tokens = excluded.cached_tokens,
           duration_ms = excluded.duration_ms,
           context_tokens = excluded.context_tokens,
           acceptance = excluded.acceptance,
           ended_at = excluded.ended_at`,
      )
      .run(
        row.id,
        row.projectId,
        row.sessionId,
        row.label,
        row.goal,
        row.access,
        JSON.stringify(row.writeScope),
        row.status,
        row.summary,
        row.blockedReason,
        row.metrics.turns,
        row.metrics.steps,
        row.metrics.tokensIn,
        row.metrics.tokensOut,
        row.metrics.cachedTokens,
        row.metrics.durationMs,
        row.metrics.contextTokens,
        JSON.stringify(row.criteria),
        row.policy,
        row.acceptance ? JSON.stringify(row.acceptance) : null,
        row.createdAt,
        row.endedAt,
      );
  }

  getExecutor(id: string): ExecutorRow | undefined {
    const raw = this.db.prepare('SELECT * FROM executor WHERE id = ?').get(id) as Row | undefined;
    return raw ? toExecutor(raw) : undefined;
  }

  /**
   * 删除 Agent 及其会话、消息。
   *
   * 三步放在一个事务里：任何一步失败都整体回滚，
   * 避免出现"executor 没了但消息还留着"的孤儿数据。
   */
  async deleteExecutor(id: string): Promise<void> {
    const row = this.db.prepare('SELECT session_id FROM executor WHERE id = ?').get(id) as
      | { session_id: string }
      | undefined;
    if (!row) return;

    const sessionId = row.session_id;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM message WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM executor WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM session WHERE id = ?').run(sessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listExecutors(
    filter: { projectId?: string; status?: readonly ExecutorStatus[] } = {},
  ): ExecutorRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    const sql = `SELECT * FROM executor${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toExecutor);
  }

  costSince(projectId: string, since: number): CostLedger {
    const raw = this.db
      .prepare(
        `SELECT COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout
         FROM executor WHERE project_id = ? AND created_at >= ?`,
      )
      .get(projectId, since) as Row | undefined;
    return {
      tokensIn: Number(raw?.tin ?? 0),
      tokensOut: Number(raw?.tout ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // 对话轮
  // -------------------------------------------------------------------------

  async appendTurn(row: TurnRow): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO turn (id, project_id, role, source, executor_id, text, judged, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.projectId,
        row.role,
        row.source,
        row.executorId,
        row.text,
        row.judged,
        row.at,
      );
  }

  async judgeTurn(id: string, judged: TurnJudgment): Promise<void> {
    this.db.prepare('UPDATE turn SET judged = ? WHERE id = ?').run(judged, id);
  }

  listTurns(projectId: string, limit = 100): TurnRow[] {
    const rows = this.db
      .prepare('SELECT * FROM turn WHERE project_id = ? ORDER BY at DESC LIMIT ?')
      .all(projectId, limit) as Row[];
    return rows
      .map(toTurn)
      .reverse();
  }

  // -------------------------------------------------------------------------
  // 汇报
  // -------------------------------------------------------------------------

  async putReport(row: ReportRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO report (id, project_id, executor_id, kind, body, needs_user, at, acked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET acked_at = excluded.acked_at`,
      )
      .run(
        row.id,
        row.projectId,
        row.executorId,
        row.kind,
        row.body,
        row.needsUser ? 1 : 0,
        row.at,
        row.ackedAt,
      );
  }

  listReports(filter: { projectId?: string; needsUser?: boolean } = {}): ReportRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.needsUser) where.push('needs_user = 1');
    const sql = `SELECT * FROM report${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toReport);
  }

  // -------------------------------------------------------------------------
  // 审批
  // -------------------------------------------------------------------------

  async putApproval(row: ApprovalRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approval (id, project_id, executor_id, category, evidence, why, tool, args, status, decided_reason, created_at, decided_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           decided_reason = excluded.decided_reason,
           decided_at = excluded.decided_at`,
      )
      .run(
        row.id,
        row.projectId,
        row.executorId,
        row.category,
        row.evidence,
        row.why,
        row.tool,
        row.args,
        row.status,
        row.decidedReason,
        row.createdAt,
        row.decidedAt,
        row.expiresAt,
      );
  }

  getApproval(id: string): ApprovalRow | undefined {
    const raw = this.db.prepare('SELECT * FROM approval WHERE id = ?').get(id) as Row | undefined;
    return raw ? toApproval(raw) : undefined;
  }

  listApprovals(
    filter: {
      projectId?: string;
      executorId?: string;
      status?: readonly ApprovalStatus[];
    } = {},
  ): ApprovalRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.executorId) {
      where.push('executor_id = ?');
      params.push(filter.executorId);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    const sql = `SELECT * FROM approval${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toApproval);
  }

  // -------------------------------------------------------------------------
  // 副作用台账
  // -------------------------------------------------------------------------

  async putSideEffect(row: SideEffectRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO side_effect (id, project_id, executor_id, kind, target, state, reversible, idempotency_key, tool, args, note, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           note = excluded.note,
           settled_at = excluded.settled_at`,
      )
      .run(
        row.id,
        row.projectId,
        row.executorId,
        row.kind,
        row.target,
        row.state,
        row.reversible ? 1 : 0,
        row.idempotencyKey,
        row.tool,
        row.args,
        row.note,
        row.createdAt,
        row.settledAt,
      );
  }

  getSideEffect(id: string): SideEffectRow | undefined {
    const raw = this.db.prepare('SELECT * FROM side_effect WHERE id = ?').get(id) as Row | undefined;
    return raw ? toSideEffect(raw) : undefined;
  }

  findSideEffectByKey(executorId: string, key: string): SideEffectRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM side_effect WHERE executor_id = ? AND idempotency_key = ? LIMIT 1')
      .get(executorId, key) as Row | undefined;
    return raw ? toSideEffect(raw) : undefined;
  }

  listSideEffects(
    filter: {
      projectId?: string;
      executorId?: string;
      state?: readonly SideEffectState[];
    } = {},
  ): SideEffectRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.executorId) {
      where.push('executor_id = ?');
      params.push(filter.executorId);
    }
    if (filter.state && filter.state.length > 0) {
      where.push(`state IN (${filter.state.map(() => '?').join(',')})`);
      params.push(...filter.state);
    }
    const sql = `SELECT * FROM side_effect${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toSideEffect);
  }

  // -------------------------------------------------------------------------
  // 记忆候选
  // -------------------------------------------------------------------------

  async putCandidate(row: MemoryCandidateRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memory_candidate (id, project_id, kind, scope, text, source, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           decided_at = excluded.decided_at`,
      )
      .run(
        row.id,
        row.projectId,
        row.kind,
        row.scope,
        row.text,
        row.source,
        row.status,
        row.createdAt,
        row.decidedAt,
      );
  }

  getCandidate(id: string): MemoryCandidateRow | undefined {
    const raw = this.db
      .prepare('SELECT * FROM memory_candidate WHERE id = ?')
      .get(id) as Row | undefined;
    return raw ? toCandidate(raw) : undefined;
  }

  listCandidates(
    filter: { projectId?: string; status?: readonly CandidateStatus[] } = {},
  ): MemoryCandidateRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.status && filter.status.length > 0) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    const sql = `SELECT * FROM memory_candidate${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as Row[];
    return rows.map(toCandidate);
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // 重复关闭忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

function toProject(raw: Row): ProjectRow {
  let guard = undefined as undefined | { perTask?: number; perDay?: number };
  if (raw.token_guard !== null && raw.token_guard !== undefined) {
    try {
      guard = JSON.parse(String(raw.token_guard)) as { perTask?: number; perDay?: number };
    } catch {
      guard = undefined;
    }
  }
  return {
    id: String(raw.id),
    name: String(raw.name),
    rootPath: String(raw.root_path),
    displayPath: String(raw.display_path),
    assistantSessionId: String(raw.assistant_session_id),
    ...(guard ? { tokenGuard: guard } : {}),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
    archived: Number(raw.archived) === 1,
  };
}

function toSession(raw: Row): SessionRow {
  return {
    id: String(raw.id),
    kind: String(raw.kind) as SessionKind,
    projectId: raw.project_id === null ? null : String(raw.project_id),
    parentSessionId: raw.parent_session_id === null ? null : String(raw.parent_session_id),
    label: String(raw.label),
    systemPrompt: String(raw.system_prompt),
    status: String(raw.status) as SessionRow['status'],
    resumable: Number(raw.resumable) === 1,
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

function toExecutor(raw: Row): ExecutorRow {
  let scope: string[] = [];
  try {
    const parsed = JSON.parse(String(raw.write_scope)) as unknown;
    if (Array.isArray(parsed)) scope = parsed.map(String);
  } catch {
    scope = [];
  }
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    sessionId: String(raw.session_id),
    label: String(raw.label),
    goal: String(raw.goal),
    access: String(raw.access ?? 'readwrite') === 'readonly' ? 'readonly' : 'readwrite',
    writeScope: scope,
    status: String(raw.status) as ExecutorStatus,
    summary: raw.summary === null ? null : String(raw.summary),
    blockedReason: raw.blocked_reason === null ? null : String(raw.blocked_reason),
    metrics: {
      turns: Number(raw.turns ?? 0),
      steps: Number(raw.steps ?? 0),
      tokensIn: Number(raw.tokens_in ?? 0),
      tokensOut: Number(raw.tokens_out ?? 0),
      cachedTokens: raw.cached_tokens === null || raw.cached_tokens === undefined ? null : Number(raw.cached_tokens),
      durationMs: Number(raw.duration_ms ?? 0),
      contextTokens:
        raw.context_tokens === null || raw.context_tokens === undefined ? null : Number(raw.context_tokens),
    },
    criteria: parseJsonField(raw.criteria, []),
    policy:
      raw.policy === 'auto' || raw.policy === 'always_human'
        ? raw.policy
        : 'unverified_only',
    acceptance: parseJsonField(raw.acceptance, null),
    createdAt: Number(raw.created_at),
    endedAt: raw.ended_at === null ? null : Number(raw.ended_at),
  };
}

/** 宽松解析 JSON 列：坏了就当默认值，不让整行读不出来。 */
function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function toTurn(raw: Row): TurnRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    role: String(raw.role) as TurnRow['role'],
    source: String(raw.source) as TurnRow['source'],
    executorId: raw.executor_id === null ? null : String(raw.executor_id),
    text: String(raw.text),
    judged: raw.judged === null ? null : (String(raw.judged) as TurnJudgment),
    at: Number(raw.at),
  };
}

function toCandidate(raw: Row): MemoryCandidateRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    kind: String(raw.kind) as MemoryCandidateRow['kind'],
    scope: String(raw.scope) === 'global' ? 'global' : 'project',
    text: String(raw.text),
    source: String(raw.source),
    status: String(raw.status) as CandidateStatus,
    createdAt: Number(raw.created_at),
    decidedAt: raw.decided_at === null ? null : Number(raw.decided_at),
  };
}

function toSideEffect(raw: Row): SideEffectRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    executorId: String(raw.executor_id),
    kind: String(raw.kind) as SideEffectKind,
    target: String(raw.target),
    state: String(raw.state) as SideEffectState,
    reversible: Number(raw.reversible) === 1,
    idempotencyKey: String(raw.idempotency_key),
    tool: String(raw.tool),
    args: String(raw.args),
    note: raw.note === null ? null : String(raw.note),
    createdAt: Number(raw.created_at),
    settledAt: raw.settled_at === null ? null : Number(raw.settled_at),
  };
}

function toApproval(raw: Row): ApprovalRow {
  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    executorId: String(raw.executor_id),
    category: String(raw.category),
    evidence: String(raw.evidence),
    why: String(raw.why),
    tool: String(raw.tool),
    args: String(raw.args),
    status: String(raw.status) as ApprovalStatus,
    decidedReason: raw.decided_reason === null ? null : String(raw.decided_reason),
    createdAt: Number(raw.created_at),
    decidedAt: raw.decided_at === null ? null : Number(raw.decided_at),
    expiresAt: Number(raw.expires_at),
  };
}

function toReport(raw: Row): ReportRow {  return {
    id: String(raw.id),
    projectId: String(raw.project_id),
    executorId: raw.executor_id === null ? null : String(raw.executor_id),
    kind: String(raw.kind) as ReportRow['kind'],
    body: String(raw.body),
    needsUser: Number(raw.needs_user) === 1,
    at: Number(raw.at),
    ackedAt: raw.acked_at === null ? null : Number(raw.acked_at),
  };
}

export { isExecutorTerminal };
