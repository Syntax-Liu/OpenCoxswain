import { DatabaseSync } from 'node:sqlite';
import {
  newId,
  now,
  type AcceptanceRecord,
  type Approval,
  type ArtifactRecord,
  type Assistant,
  type CostLedger,
  type DecisionBrief,
  type EventRecord,
  type Evidence,
  type Message,
  type Project,
  type ProjectCostReport,
  type ReviewLatency,
  type Run,
  type RunStatus,
  type SideEffect,
  type SideEffectKind,
  type SideEffectState,
  type SupervisionAction,
  type Task,
  type TaskEdge,
  type TaskInput,
  type TaskMandate,
  type TaskStatus,
  type Worker,
  type WorkerResult,
  type WorkerStatus,
} from '@opencoxswain/shared';

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  return String(row[key] ?? '');
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

function number(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 最近秩百分位；空样本返回 null。 */
function percentile(values: number[], rank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

function toBrief(row: Row): DecisionBrief {
  return {
    taskId: text(row, 'task_id'),
    changed: text(row, 'changed'),
    why: text(row, 'why'),
    verified: text(row, 'verified'),
    risks: text(row, 'risks'),
    evidenceRefs: parseJson<string[]>(row.evidence_refs, []),
    conflictReason: nullableText(row, 'conflict_reason'),
    generatedAt: number(row, 'generated_at'),
  };
}

const ACCEPTANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  digest       TEXT NOT NULL,
  produced_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

CREATE TABLE IF NOT EXISTS acceptance_records (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  criterion_id   TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  evidence_ids   TEXT NOT NULL,
  judged_by      TEXT NOT NULL,
  judged_by_user TEXT,
  note           TEXT,
  at             INTEGER NOT NULL,
  PRIMARY KEY (task_id, criterion_id)
);
`;

const INPUT_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_inputs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  text         TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inputs_task ON task_inputs(task_id);

CREATE TABLE IF NOT EXISTS supervision_actions (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id TEXT,
  rule      TEXT NOT NULL,
  verdict   TEXT NOT NULL,
  reason    TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supervision_task ON supervision_actions(task_id);
`;

const LEASE_SCHEMA = `
ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'running';
ALTER TABLE runs ADD COLUMN lease_owner TEXT;
ALTER TABLE runs ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE runs ADD COLUMN last_heartbeat_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs(lease_expires_at);

CREATE TABLE IF NOT EXISTS task_mandates (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scope_json  TEXT NOT NULL,
  strength    TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  issued_by   TEXT NOT NULL,
  issued_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_task ON task_mandates(task_id, issued_at DESC);
`;

const AUTHORITY_SCHEMA = `
ALTER TABLE projects ADD COLUMN allow_network INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN allow_external_send INTEGER NOT NULL DEFAULT 0;

DROP TABLE IF EXISTS task_mandates;
CREATE TABLE task_mandates (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  capabilities_json TEXT NOT NULL,
  root              TEXT NOT NULL,
  roles_json        TEXT NOT NULL,
  budget_json       TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  issued_by         TEXT NOT NULL,
  issued_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_task ON task_mandates(task_id, issued_at DESC);

CREATE TABLE IF NOT EXISTS side_effects (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id       TEXT,
  run_id          TEXT,
  kind            TEXT NOT NULL,
  target          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reversible      INTEGER NOT NULL,
  state           TEXT NOT NULL,
  result          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_side_effects_task ON side_effects(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_side_effects_key ON side_effects(idempotency_key);
`;

const REVIEW_SCHEMA = `
ALTER TABLE tasks ADD COLUMN finished_at INTEGER;
ALTER TABLE tasks ADD COLUMN first_viewed_at INTEGER;
ALTER TABLE tasks ADD COLUMN decided_at INTEGER;

CREATE TABLE IF NOT EXISTS decision_briefs (
  task_id         TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  changed         TEXT NOT NULL,
  why             TEXT NOT NULL,
  verified        TEXT NOT NULL,
  risks           TEXT NOT NULL,
  evidence_refs   TEXT NOT NULL,
  conflict_reason TEXT,
  generated_at    INTEGER NOT NULL
);
`;

const RECOVERY_SCHEMA = `
ALTER TABLE runs ADD COLUMN recovered_unknown INTEGER NOT NULL DEFAULT 0;
`;

const SCHEMA = `
CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  path             TEXT NOT NULL,
  default_branch   TEXT NOT NULL,
  daily_budget_usd REAL NOT NULL DEFAULT 10,
  max_concurrency  INTEGER NOT NULL DEFAULT 2,
  created_at       INTEGER NOT NULL
);

CREATE TABLE assistants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  avatar      TEXT NOT NULL DEFAULT '',
  persona     TEXT NOT NULL DEFAULT '',
  tone        TEXT NOT NULL DEFAULT 'concise',
  proactivity TEXT NOT NULL DEFAULT 'ask_first',
  created_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL,
  assignee_id   TEXT,
  contract_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, created_at);

CREATE TABLE task_edges (
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'depends_on',
  PRIMARY KEY (from_task_id, to_task_id)
);

CREATE TABLE workers (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  runtime       TEXT NOT NULL,
  model         TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch        TEXT NOT NULL,
  session_ref   TEXT,
  status        TEXT NOT NULL,
  cost_json     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_workers_task ON workers(task_id);

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  worker_id   TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  result_json TEXT,
  error       TEXT
);

CREATE TABLE evidence (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref          TEXT NOT NULL,
  digest       TEXT NOT NULL,
  produced_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_evidence_task ON evidence(task_id);

CREATE TABLE acceptance_records (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  criterion_id   TEXT NOT NULL,
  verdict        TEXT NOT NULL,
  evidence_ids   TEXT NOT NULL,
  judged_by      TEXT NOT NULL,
  judged_by_user TEXT,
  note           TEXT,
  at             INTEGER NOT NULL,
  PRIMARY KEY (task_id, criterion_id)
);

CREATE TABLE task_inputs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  text         TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_inputs_task ON task_inputs(task_id);

CREATE TABLE supervision_actions (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id TEXT,
  rule      TEXT NOT NULL,
  verdict   TEXT NOT NULL,
  reason    TEXT NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX idx_supervision_task ON supervision_actions(task_id);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT,
  worker_id  TEXT,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_task ON events(task_id, id);

CREATE TABLE artifacts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  path       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  meta_json  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   INTEGER,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE model_calls (
  id         TEXT PRIMARY KEY,
  worker_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  tokens_in  INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost       REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_model_calls_created ON model_calls(created_at);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_project ON messages(project_id, created_at);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    const version = number(row, 'user_version');
    if (version >= 7) return;
    this.db.exec('BEGIN;');
    try {
      if (version < 1) {
        this.db.exec(SCHEMA);
      } else if (version < 2) {
        this.db.exec(ACCEPTANCE_SCHEMA);
      }
      if (version < 3) this.db.exec(INPUT_SCHEMA);
      if (version < 4) this.db.exec(LEASE_SCHEMA);
      if (version < 5) this.db.exec(AUTHORITY_SCHEMA);
      if (version < 6) this.db.exec(REVIEW_SCHEMA);
      if (version < 7) this.db.exec(RECOVERY_SCHEMA);
      this.db.exec('PRAGMA user_version = 7;');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- projects ----------

  createProject(input: {
    name: string;
    path: string;
    defaultBranch: string;
    dailyBudgetUsd: number;
    maxConcurrency: number;
    allowNetwork?: boolean;
    allowExternalSend?: boolean;
  }): Project {
    const project: Project = {
      id: newId('prj'),
      name: input.name,
      path: input.path,
      defaultBranch: input.defaultBranch,
      dailyBudgetUsd: input.dailyBudgetUsd,
      maxConcurrency: input.maxConcurrency,
      allowNetwork: input.allowNetwork ?? true,
      allowExternalSend: input.allowExternalSend ?? false,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, default_branch, daily_budget_usd, max_concurrency, allow_network, allow_external_send, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.defaultBranch,
        project.dailyBudgetUsd,
        project.maxConcurrency,
        project.allowNetwork ? 1 : 0,
        project.allowExternalSend ? 1 : 0,
        project.createdAt,
      );
    return project;
  }

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as Row[];
    return rows.map((row) => this.mapProject(row));
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapProject(row) : null;
  }

  updateProjectSettings(
    id: string,
    patch: { dailyBudgetUsd?: number; maxConcurrency?: number },
  ): Project {
    const current = this.requireProject(id);
    const next: Project = {
      ...current,
      dailyBudgetUsd: patch.dailyBudgetUsd ?? current.dailyBudgetUsd,
      maxConcurrency: patch.maxConcurrency ?? current.maxConcurrency,
    };
    this.db
      .prepare('UPDATE projects SET daily_budget_usd = ?, max_concurrency = ? WHERE id = ?')
      .run(next.dailyBudgetUsd, next.maxConcurrency, id);
    return next;
  }

  private requireProject(id: string): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`项目不存在：${id}`);
    return project;
  }

  private mapProject(row: Row): Project {
    return {
      id: text(row, 'id'),
      name: text(row, 'name'),
      path: text(row, 'path'),
      defaultBranch: text(row, 'default_branch'),
      dailyBudgetUsd: number(row, 'daily_budget_usd'),
      maxConcurrency: number(row, 'max_concurrency'),
      allowNetwork: number(row, 'allow_network') !== 0,
      allowExternalSend: number(row, 'allow_external_send') !== 0,
      createdAt: number(row, 'created_at'),
    };
  }

  // ---------- assistant ----------

  ensureAssistant(): Assistant {
    const rows = this.db.prepare('SELECT * FROM assistants LIMIT 1').all() as Row[];
    if (rows[0]) return this.mapAssistant(rows[0]);
    const assistant: Assistant = {
      id: newId('ast'),
      name: '舵手',
      avatar: 'cox',
      persona: '你只对结果负责。先拆解、再派发、盯进度、做验收，不亲自干活。',
      tone: 'concise',
      proactivity: 'ask_first',
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO assistants (id, name, avatar, persona, tone, proactivity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        assistant.id,
        assistant.name,
        assistant.avatar,
        assistant.persona,
        assistant.tone,
        assistant.proactivity,
        assistant.createdAt,
      );
    return assistant;
  }

  updateAssistant(
    patch: Partial<Pick<Assistant, 'name' | 'avatar' | 'persona' | 'tone' | 'proactivity'>>,
  ): Assistant {
    const next = { ...this.ensureAssistant(), ...patch };
    this.db
      .prepare(
        'UPDATE assistants SET name = ?, avatar = ?, persona = ?, tone = ?, proactivity = ? WHERE id = ?',
      )
      .run(next.name, next.avatar, next.persona, next.tone, next.proactivity, next.id);
    return next;
  }

  private mapAssistant(row: Row): Assistant {
    return {
      id: text(row, 'id'),
      name: text(row, 'name'),
      avatar: text(row, 'avatar'),
      persona: text(row, 'persona'),
      tone: text(row, 'tone') as Assistant['tone'],
      proactivity: text(row, 'proactivity') as Assistant['proactivity'],
      createdAt: number(row, 'created_at'),
    };
  }

  // ---------- tasks ----------

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, parent_id, title, goal, status, assignee_id,
                            contract_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.parentId,
        task.title,
        task.goal,
        task.status,
        task.assigneeId,
        JSON.stringify(task.contract),
        task.createdAt,
        task.updatedAt,
      );
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapTask(row) : null;
  }

  listTasks(projectId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  listChildren(parentId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC')
      .all(parentId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  listRootTasks(projectId: string): Task[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tasks WHERE project_id = ? AND parent_id IS NULL ORDER BY created_at ASC',
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.mapTask(row));
  }

  setTaskStatus(id: string, status: TaskStatus): void {
    const at = now();
    if (status === 'awaiting_review' || status === 'done') {
      this.db
        .prepare(
          'UPDATE tasks SET status = ?, updated_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?',
        )
        .run(status, at, at, id);
      return;
    }
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, at, id);
  }

  /** 人首次打开验收单；重复调用不覆盖更早的时间。 */
  markTaskViewed(id: string): void {
    this.db
      .prepare('UPDATE tasks SET first_viewed_at = ? WHERE id = ? AND first_viewed_at IS NULL')
      .run(now(), id);
  }

  /** 人给出该任务的验收结论。 */
  markTaskDecided(id: string): void {
    this.db
      .prepare('UPDATE tasks SET decided_at = COALESCE(decided_at, ?) WHERE id = ?')
      .run(now(), id);
  }

  setTaskAssignee(id: string, assigneeId: string | null): void {
    this.db
      .prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?')
      .run(assigneeId, now(), id);
  }

  updateTaskContract(id: string, contract: Task['contract']): void {
    this.db
      .prepare('UPDATE tasks SET contract_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(contract), now(), id);
  }

  private mapTask(row: Row): Task {
    return {
      id: text(row, 'id'),
      projectId: text(row, 'project_id'),
      parentId: nullableText(row, 'parent_id'),
      title: text(row, 'title'),
      goal: text(row, 'goal'),
      status: text(row, 'status') as TaskStatus,
      assigneeId: nullableText(row, 'assignee_id'),
      contract: parseJson(row.contract_json, {} as Task['contract']),
      createdAt: number(row, 'created_at'),
      updatedAt: number(row, 'updated_at'),
      finishedAt: nullableNumber(row, 'finished_at'),
      firstViewedAt: nullableNumber(row, 'first_viewed_at'),
      decidedAt: nullableNumber(row, 'decided_at'),
    };
  }

  // ---------- edges ----------

  insertEdge(fromTaskId: string, toTaskId: string, type = 'depends_on'): void {
    this.db
      .prepare('INSERT INTO task_edges (from_task_id, to_task_id, type) VALUES (?, ?, ?)')
      .run(fromTaskId, toTaskId, type);
  }

  listEdges(projectId: string): TaskEdge[] {
    const rows = this.db
      .prepare(
        `SELECT e.from_task_id, e.to_task_id, e.type
         FROM task_edges e JOIN tasks t ON t.id = e.to_task_id
         WHERE t.project_id = ?`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => ({
      fromTaskId: text(row, 'from_task_id'),
      toTaskId: text(row, 'to_task_id'),
      type: text(row, 'type'),
    }));
  }

  // ---------- workers ----------

  insertWorker(worker: Worker): void {
    this.db
      .prepare(
        `INSERT INTO workers (id, task_id, role, runtime, model, worktree_path, branch,
                              session_ref, status, cost_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        worker.id,
        worker.taskId,
        worker.role,
        worker.runtime,
        worker.model,
        worker.worktreePath,
        worker.branch,
        worker.sessionRef,
        worker.status,
        JSON.stringify(worker.cost),
        worker.createdAt,
        worker.updatedAt,
      );
  }

  getWorker(id: string): Worker | null {
    const row = this.db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapWorker(row) : null;
  }

  getWorkerByTask(taskId: string): Worker | null {
    const row = this.db
      .prepare('SELECT * FROM workers WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as Row | undefined;
    return row ? this.mapWorker(row) : null;
  }

  listWorkers(projectId: string): Worker[] {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM workers w JOIN tasks t ON t.id = w.task_id
         WHERE t.project_id = ? ORDER BY w.created_at ASC`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.mapWorker(row));
  }

  updateWorker(
    id: string,
    patch: Partial<Pick<Worker, 'status' | 'sessionRef' | 'cost' | 'worktreePath' | 'branch'>>,
  ): Worker {
    const current = this.getWorker(id);
    if (!current) throw new Error(`员工不存在：${id}`);
    const next: Worker = { ...current, ...patch, updatedAt: now() };
    this.db
      .prepare(
        `UPDATE workers SET worktree_path = ?, branch = ?, session_ref = ?, status = ?,
                            cost_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.worktreePath,
        next.branch,
        next.sessionRef,
        next.status,
        JSON.stringify(next.cost),
        next.updatedAt,
        id,
      );
    return next;
  }

  private mapWorker(row: Row): Worker {
    return {
      id: text(row, 'id'),
      taskId: text(row, 'task_id'),
      role: text(row, 'role') as Worker['role'],
      runtime: text(row, 'runtime'),
      model: text(row, 'model'),
      worktreePath: text(row, 'worktree_path'),
      branch: text(row, 'branch'),
      sessionRef: nullableText(row, 'session_ref'),
      status: text(row, 'status') as WorkerStatus,
      cost: parseJson(row.cost_json, {
        tokensIn: 0,
        tokensOut: 0,
        usd: 0,
        minutes: 0,
      } satisfies CostLedger),
      createdAt: number(row, 'created_at'),
      updatedAt: number(row, 'updated_at'),
    };
  }

  // ---------- runs ----------

  insertRun(id: string, workerId: string, attempt: number): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, worker_id, attempt, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(id, workerId, attempt, now());
  }

  finishRun(id: string, result: WorkerResult | null, error: string | null): void {
    this.db
      .prepare(
        `UPDATE runs SET ended_at = ?, result_json = ?, error = ?, status = ?,
                        lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(
        now(),
        result ? JSON.stringify(result) : null,
        error,
        error ? 'failed' : 'done',
        id,
      );
  }

  /** 原子认领租约：无主、已过期或同一 owner 才能抢到。 */
  claimRun(runId: string, owner: string, ttlMs: number): boolean {
    const at = now();
    const result = this.db
      .prepare(
        `UPDATE runs
         SET lease_owner = ?, lease_expires_at = ?, last_heartbeat_at = ?
         WHERE id = ? AND status = 'running' AND ended_at IS NULL
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at IS NULL OR lease_expires_at < ?)`,
      )
      .run(owner, at + ttlMs, at, runId, owner, at);
    return Number(result.changes) > 0;
  }

  renewLease(runId: string, owner: string, ttlMs: number): boolean {
    const at = now();
    const result = this.db
      .prepare(
        `UPDATE runs SET lease_expires_at = ?, last_heartbeat_at = ?
         WHERE id = ? AND lease_owner = ? AND status = 'running'
           AND lease_expires_at IS NOT NULL AND lease_expires_at >= ?`,
      )
      .run(at + ttlMs, at, runId, owner, at);
    return Number(result.changes) > 0;
  }

  releaseRun(runId: string): void {
    this.db
      .prepare('UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?')
      .run(runId);
  }

  listExpiredRuns(at: number): Array<{ taskId: string; runId: string; workerId: string }> {
    const rows = this.db
      .prepare(
        `SELECT r.id AS run_id, r.worker_id, w.task_id
         FROM runs r JOIN workers w ON w.id = r.worker_id
         WHERE r.status = 'running' AND r.ended_at IS NULL
           AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at < ?`,
      )
      .all(at) as Row[];
    return rows.map((row) => ({
      taskId: text(row, 'task_id'),
      runId: text(row, 'run_id'),
      workerId: text(row, 'worker_id'),
    }));
  }

  markRunOrphaned(runId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET status = 'orphaned', lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ?`,
      )
      .run(runId);
  }

  /** 重启时租约仍未过期：保留 running，但持久化“结果未知”，供监察与重试判断。 */
  markRunRecoveredUnknown(runId: string): void {
    this.db
      .prepare('UPDATE runs SET recovered_unknown = 1 WHERE id = ?')
      .run(runId);
  }

  reviveRun(runId: string, workerId: string, owner: string, ttlMs: number): void {
    const at = now();
    this.db
      .prepare(
        `UPDATE runs
         SET worker_id = ?, attempt = attempt + 1, status = 'running', lease_owner = ?,
             lease_expires_at = ?, last_heartbeat_at = ?, ended_at = NULL, error = NULL
         WHERE id = ?`,
      )
      .run(workerId, owner, at + ttlMs, at, runId);
  }

  takeOrphanRun(taskId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.id FROM runs r JOIN workers w ON w.id = r.worker_id
         WHERE w.task_id = ? AND r.status = 'orphaned'
         ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? text(row, 'id') : null;
  }

  getActiveRun(taskId: string): Run | null {
    const row = this.db
      .prepare(
        `SELECT r.*, w.task_id FROM runs r JOIN workers w ON w.id = r.worker_id
         WHERE w.task_id = ? AND r.ended_at IS NULL
         ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? mapRun(row) : null;
  }

  listOrphanedRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, w.task_id FROM runs r JOIN workers w ON w.id = r.worker_id
         WHERE r.status = 'orphaned' ORDER BY r.started_at DESC`,
      )
      .all() as Row[];
    return rows.map(mapRun);
  }

  // ---------- mandates ----------

  insertMandate(mandate: TaskMandate): void {
    this.db
      .prepare(
        `INSERT INTO task_mandates
           (id, task_id, capabilities_json, root, roles_json, budget_json, expires_at, issued_by, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mandate.id,
        mandate.taskId,
        JSON.stringify(mandate.capabilities),
        mandate.root,
        JSON.stringify(mandate.roles),
        JSON.stringify(mandate.budget),
        mandate.expiresAt,
        mandate.issuedBy,
        mandate.issuedAt,
      );
  }

  getLatestMandate(taskId: string): TaskMandate | null {
    const row = this.db
      .prepare(
        'SELECT * FROM task_mandates WHERE task_id = ? ORDER BY issued_at DESC, id DESC LIMIT 1',
      )
      .get(taskId) as Row | undefined;
    return row ? mapMandate(row) : null;
  }

  listTaskMandates(taskId: string): TaskMandate[] {
    const rows = this.db
      .prepare('SELECT * FROM task_mandates WHERE task_id = ? ORDER BY issued_at ASC, id ASC')
      .all(taskId) as Row[];
    return rows.map(mapMandate);
  }

  // ---------- side effects ----------

  insertSideEffect(input: {
    taskId: string;
    workerId: string | null;
    runId: string | null;
    kind: SideEffectKind;
    target: string;
    idempotencyKey: string;
    reversible: boolean;
  }): SideEffect {
    const at = now();
    const effect: SideEffect = {
      id: newId('sfx'),
      taskId: input.taskId,
      workerId: input.workerId,
      runId: input.runId,
      kind: input.kind,
      target: input.target,
      idempotencyKey: input.idempotencyKey,
      reversible: input.reversible,
      state: 'pending',
      result: null,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO side_effects
           (id, task_id, worker_id, run_id, kind, target, idempotency_key, reversible, state, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        effect.id,
        effect.taskId,
        effect.workerId,
        effect.runId,
        effect.kind,
        effect.target,
        effect.idempotencyKey,
        effect.reversible ? 1 : 0,
        effect.state,
        effect.result,
        effect.createdAt,
        effect.updatedAt,
      );
    return effect;
  }

  getSideEffectByKey(taskId: string, idempotencyKey: string): SideEffect | null {
    const row = this.db
      .prepare(
        'SELECT * FROM side_effects WHERE task_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(taskId, idempotencyKey) as Row | undefined;
    return row ? mapSideEffect(row) : null;
  }

  updateSideEffect(
    id: string,
    patch: { state?: SideEffectState; result?: string | null },
  ): SideEffect {
    const row = this.db.prepare('SELECT * FROM side_effects WHERE id = ?').get(id) as
      | Row
      | undefined;
    if (!row) throw new Error(`副作用记录不存在：${id}`);
    const current = mapSideEffect(row);
    const next: SideEffect = {
      ...current,
      state: patch.state ?? current.state,
      result: patch.result === undefined ? current.result : patch.result,
      updatedAt: now(),
    };
    this.db
      .prepare('UPDATE side_effects SET state = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(next.state, next.result, next.updatedAt, id);
    return next;
  }

  listTaskSideEffects(taskId: string): SideEffect[] {
    const rows = this.db
      .prepare('SELECT * FROM side_effects WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Row[];
    return rows.map(mapSideEffect);
  }

  /** 未结算的副作用：进程被杀后重启时据此提示“可能有未完成动作”。 */
  listPendingSideEffects(): SideEffect[] {
    const rows = this.db
      .prepare("SELECT * FROM side_effects WHERE state = 'pending' ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(mapSideEffect);
  }

  getLatestResult(taskId: string): WorkerResult | null {
    const row = this.db
      .prepare(
        `SELECT r.result_json FROM runs r JOIN workers w ON w.id = r.worker_id
         WHERE w.task_id = ? ORDER BY r.started_at DESC LIMIT 1`,
      )
      .get(taskId) as Row | undefined;
    return row ? parseJson<WorkerResult | null>(row.result_json, null) : null;
  }

  // ---------- acceptance & evidence ----------

  insertEvidence(items: Evidence[]): void {
    const statement = this.db.prepare(
      `INSERT INTO evidence (id, task_id, criterion_id, kind, ref, digest, produced_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const item of items) {
      statement.run(
        item.id,
        item.taskId,
        item.criterionId,
        item.kind,
        item.ref,
        item.digest,
        item.producedBy,
        item.createdAt,
      );
    }
  }

  upsertAcceptance(records: AcceptanceRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO acceptance_records
         (task_id, criterion_id, verdict, evidence_ids, judged_by, judged_by_user, note, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, criterion_id) DO UPDATE SET
         verdict = excluded.verdict,
         evidence_ids = excluded.evidence_ids,
         judged_by = excluded.judged_by,
         judged_by_user = excluded.judged_by_user,
         note = excluded.note,
         at = excluded.at`,
    );
    for (const record of records) {
      statement.run(
        record.taskId,
        record.criterionId,
        record.verdict,
        JSON.stringify(record.evidenceIds),
        record.judgedBy,
        record.judgedByUser ?? null,
        record.note ?? null,
        record.at,
      );
    }
  }

  listTaskAcceptance(taskId: string): AcceptanceRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM acceptance_records WHERE task_id = ? ORDER BY criterion_id ASC')
      .all(taskId) as Row[];
    return rows.map(toAcceptanceRecord);
  }

  // ---------- decision briefs ----------

  upsertBrief(brief: DecisionBrief): void {
    this.db
      .prepare(
        `INSERT INTO decision_briefs
           (task_id, changed, why, verified, risks, evidence_refs, conflict_reason, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           changed = excluded.changed,
           why = excluded.why,
           verified = excluded.verified,
           risks = excluded.risks,
           evidence_refs = excluded.evidence_refs,
           conflict_reason = excluded.conflict_reason,
           generated_at = excluded.generated_at`,
      )
      .run(
        brief.taskId,
        brief.changed,
        brief.why,
        brief.verified,
        brief.risks,
        JSON.stringify(brief.evidenceRefs),
        brief.conflictReason,
        brief.generatedAt,
      );
  }

  getBrief(taskId: string): DecisionBrief | null {
    const row = this.db
      .prepare('SELECT * FROM decision_briefs WHERE task_id = ?')
      .get(taskId) as Row | undefined;
    return row ? toBrief(row) : null;
  }

  /** 反馈延迟：完成 → 首次查看 → 给出结论，按任务落库字段直接统计。 */
  reviewLatency(projectId?: string | null): ReviewLatency {
    const rows = (
      projectId
        ? this.db
            .prepare(
              'SELECT status, finished_at, first_viewed_at, decided_at FROM tasks WHERE project_id = ? AND finished_at IS NOT NULL',
            )
            .all(projectId)
        : this.db
            .prepare(
              'SELECT status, finished_at, first_viewed_at, decided_at FROM tasks WHERE finished_at IS NOT NULL',
            )
            .all()
    ) as Row[];
    const viewLag: number[] = [];
    const decideLag: number[] = [];
    let waiting = 0;
    for (const row of rows) {
      const finishedAt = nullableNumber(row, 'finished_at');
      if (finishedAt === null) continue;
      if (text(row, 'status') === 'awaiting_review') waiting += 1;
      const viewedAt = nullableNumber(row, 'first_viewed_at');
      const decidedAt = nullableNumber(row, 'decided_at');
      if (viewedAt !== null) viewLag.push(Math.max(0, viewedAt - finishedAt));
      if (decidedAt !== null) decideLag.push(Math.max(0, decidedAt - finishedAt));
    }
    return {
      samples: decideLag.length,
      waiting,
      viewLagP50: percentile(viewLag, 50),
      viewLagP95: percentile(viewLag, 95),
      decideLagP50: percentile(decideLag, 50),
      decideLagP95: percentile(decideLag, 95),
    };
  }

  listProjectAcceptance(projectId: string): AcceptanceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM acceptance_records a
         JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ?
         ORDER BY t.created_at ASC, a.criterion_id ASC`,
      )
      .all(projectId) as Row[];
    return rows.map(toAcceptanceRecord);
  }

  listTaskEvidence(taskId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Row[];
    return rows.map(toEvidence);
  }

  listProjectEvidence(projectId: string): Evidence[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM evidence e
         JOIN tasks t ON t.id = e.task_id
         WHERE t.project_id = ?
         ORDER BY e.created_at ASC`,
      )
      .all(projectId) as Row[];
    return rows.map(toEvidence);
  }

  // ---------- inputs & supervision ----------

  insertInput(input: TaskInput): void {
    this.db
      .prepare(
        `INSERT INTO task_inputs (id, task_id, source, text, state, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.taskId,
        input.source,
        input.text,
        input.state,
        input.createdAt,
        input.deliveredAt ?? null,
      );
  }

  updateInputState(id: string, state: TaskInput['state'], deliveredAt?: number): void {
    this.db
      .prepare(
        'UPDATE task_inputs SET state = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?',
      )
      .run(state, deliveredAt ?? null, id);
  }

  listTaskInputs(taskId: string): TaskInput[] {
    const rows = this.db
      .prepare('SELECT * FROM task_inputs WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Row[];
    return rows.map(toTaskInput);
  }

  listProjectInputs(projectId: string): TaskInput[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM task_inputs i
         JOIN tasks t ON t.id = i.task_id
         WHERE t.project_id = ?
         ORDER BY i.created_at ASC`,
      )
      .all(projectId) as Row[];
    return rows.map(toTaskInput);
  }

  insertSupervisionAction(action: SupervisionAction): void {
    this.db
      .prepare(
        `INSERT INTO supervision_actions (id, task_id, worker_id, rule, verdict, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        action.id,
        action.taskId,
        action.workerId,
        action.rule,
        action.verdict,
        action.reason,
        action.at,
      );
  }

  listTaskSupervision(taskId: string): SupervisionAction[] {
    const rows = this.db
      .prepare('SELECT * FROM supervision_actions WHERE task_id = ? ORDER BY at ASC')
      .all(taskId) as Row[];
    return rows.map(toSupervisionAction);
  }

  // ---------- events ----------

  appendEvent(input: {
    taskId: string | null;
    workerId?: string | null;
    type: string;
    payload: unknown;
  }): EventRecord {
    const createdAt = now();
    const result = this.db
      .prepare(
        'INSERT INTO events (task_id, worker_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        input.taskId,
        input.workerId ?? null,
        input.type,
        JSON.stringify(input.payload ?? null),
        createdAt,
      );
    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt,
    };
  }

  listEvents(projectId: string | null, afterId = 0, limit = 200): EventRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT e.* FROM events e JOIN tasks t ON t.id = e.task_id
             WHERE t.project_id = ? AND e.id > ? ORDER BY e.id ASC LIMIT ?`,
          )
          .all(projectId, afterId, limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?')
          .all(afterId, limit) as Row[]);
    return rows.map((row) => this.mapEvent(row));
  }

  listRecentEvents(projectId: string | null, limit = 200): EventRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT e.* FROM events e JOIN tasks t ON t.id = e.task_id
             WHERE t.project_id = ? ORDER BY e.id DESC LIMIT ?`,
          )
          .all(projectId, limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
          .all(limit) as Row[]);
    return rows.reverse().map((row) => this.mapEvent(row));
  }

  listTaskEvents(taskId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as Row[];
    return rows.map((row) => this.mapEvent(row));
  }

  private mapEvent(row: Row): EventRecord {
    return {
      id: number(row, 'id'),
      taskId: nullableText(row, 'task_id'),
      workerId: nullableText(row, 'worker_id'),
      type: text(row, 'type'),
      payload: parseJson(row.payload, null),
      createdAt: number(row, 'created_at'),
    };
  }

  // ---------- artifacts ----------

  insertArtifact(input: {
    taskId: string;
    type: ArtifactRecord['type'];
    path: string;
    hash: string;
    meta?: ArtifactRecord['meta'];
  }): ArtifactRecord {
    const artifact: ArtifactRecord = {
      id: newId('art'),
      taskId: input.taskId,
      type: input.type,
      path: input.path,
      hash: input.hash,
      meta: input.meta,
      createdAt: now(),
    };
    this.db
      .prepare(
        'INSERT INTO artifacts (id, task_id, type, path, hash, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        artifact.id,
        artifact.taskId,
        artifact.type,
        artifact.path,
        artifact.hash,
        artifact.meta ? JSON.stringify(artifact.meta) : null,
        artifact.createdAt,
      );
    return artifact;
  }

  listArtifacts(projectId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM artifacts a JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ? ORDER BY a.created_at ASC`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.mapArtifact(row));
  }

  listTaskArtifacts(taskId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC')
      .all(taskId) as Row[];
    return rows.map((row) => this.mapArtifact(row));
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  private mapArtifact(row: Row): ArtifactRecord {
    return {
      id: text(row, 'id'),
      taskId: text(row, 'task_id'),
      type: text(row, 'type') as ArtifactRecord['type'],
      path: text(row, 'path'),
      hash: text(row, 'hash'),
      meta: parseJson<ArtifactRecord['meta'] | undefined>(row.meta_json, undefined),
      createdAt: number(row, 'created_at'),
    };
  }

  // ---------- approvals ----------

  insertApproval(input: {
    taskId: string;
    type: string;
    requestedBy: string;
    payload: unknown;
  }): Approval {
    const approval: Approval = {
      id: newId('apr'),
      taskId: input.taskId,
      type: input.type,
      requestedBy: input.requestedBy,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      payload: input.payload,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, type, requested_by, status, decided_by, decided_at, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.taskId,
        approval.type,
        approval.requestedBy,
        approval.status,
        approval.decidedBy,
        approval.decidedAt,
        JSON.stringify(approval.payload),
        approval.createdAt,
      );
    return approval;
  }

  listApprovals(projectId: string): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM approvals a JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ? ORDER BY a.created_at ASC`,
      )
      .all(projectId) as Row[];
    return rows.map((row) => this.mapApproval(row));
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.mapApproval(row) : null;
  }

  decideApproval(id: string, status: 'approved' | 'rejected', decidedBy: string): Approval {
    const current = this.getApproval(id);
    if (!current) throw new Error(`审批不存在：${id}`);
    const decidedAt = now();
    this.db
      .prepare('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
      .run(status, decidedBy, decidedAt, id);
    return { ...current, status, decidedBy, decidedAt };
  }

  private mapApproval(row: Row): Approval {
    return {
      id: text(row, 'id'),
      taskId: text(row, 'task_id'),
      type: text(row, 'type'),
      requestedBy: text(row, 'requested_by'),
      status: text(row, 'status') as Approval['status'],
      decidedBy: nullableText(row, 'decided_by'),
      decidedAt: row.decided_at === null || row.decided_at === undefined ? null : number(row, 'decided_at'),
      payload: parseJson(row.payload, null),
      createdAt: number(row, 'created_at'),
    };
  }

  // ---------- messages ----------

  insertMessage(input: {
    projectId: string;
    role: Message['role'];
    content: string;
  }): Message {
    const message: Message = {
      id: newId('msg'),
      projectId: input.projectId,
      role: input.role,
      content: input.content,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO messages (id, project_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, message.projectId, message.role, message.content, message.createdAt);
    return message;
  }

  listMessages(projectId: string, limit = 100): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(projectId, limit) as Row[];
    return rows.map((row) => ({
      id: text(row, 'id'),
      projectId: text(row, 'project_id'),
      role: text(row, 'role') as Message['role'],
      content: text(row, 'content'),
      createdAt: number(row, 'created_at'),
    }));
  }

  // ---------- costs ----------

  insertModelCall(input: {
    workerId: string;
    model: string;
    cost: CostLedger;
  }): void {
    this.db
      .prepare(
        `INSERT INTO model_calls (id, worker_id, model, tokens_in, tokens_out, cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('mcl'),
        input.workerId,
        input.model,
        input.cost.tokensIn,
        input.cost.tokensOut,
        input.cost.usd,
        now(),
      );
  }

  sumTaskCost(taskId: string): CostLedger {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(m.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(m.tokens_out), 0) AS tokens_out,
                COALESCE(SUM(m.cost), 0) AS usd
         FROM model_calls m JOIN workers w ON w.id = m.worker_id
         WHERE w.task_id = ?`,
      )
      .get(taskId) as Row;
    return {
      tokensIn: number(row, 'tokens_in'),
      tokensOut: number(row, 'tokens_out'),
      usd: number(row, 'usd'),
      minutes: 0,
    };
  }

  sumProjectCostSince(projectId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(m.cost), 0) AS usd
         FROM model_calls m
         JOIN workers w ON w.id = m.worker_id
         JOIN tasks t ON t.id = w.task_id
         WHERE t.project_id = ? AND m.created_at >= ?`,
      )
      .get(projectId, since) as Row;
    return number(row, 'usd');
  }

  projectCostReport(projectId: string): ProjectCostReport {
    const from = `FROM model_calls m
      JOIN workers w ON w.id = m.worker_id
      JOIN tasks t ON t.id = w.task_id
      WHERE t.project_id = ?`;
    const total = this.db
      .prepare(
        `SELECT COALESCE(SUM(m.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(m.tokens_out), 0) AS tokens_out,
                COALESCE(SUM(m.cost), 0) AS usd ${from}`,
      )
      .get(projectId) as Row;
    const byModel = this.db
      .prepare(
        `SELECT m.model AS key,
                COALESCE(SUM(m.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(m.tokens_out), 0) AS tokens_out,
                COALESCE(SUM(m.cost), 0) AS usd ${from}
         GROUP BY m.model ORDER BY usd DESC`,
      )
      .all(projectId) as Row[];
    const byTask = this.db
      .prepare(
        `SELECT t.id AS key, t.title AS title, COALESCE(SUM(m.cost), 0) AS usd ${from}
         GROUP BY t.id ORDER BY usd DESC`,
      )
      .all(projectId) as Row[];
    const daily = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(m.cost), 0) AS usd ${from}
         GROUP BY day ORDER BY day`,
      )
      .all(projectId) as Row[];
    return {
      totalUsd: number(total, 'usd'),
      tokensIn: number(total, 'tokens_in'),
      tokensOut: number(total, 'tokens_out'),
      byModel: byModel.map((row) => ({
        key: text(row, 'key'),
        usd: number(row, 'usd'),
        tokensIn: number(row, 'tokens_in'),
        tokensOut: number(row, 'tokens_out'),
      })),
      byTask: byTask.map((row) => ({
        taskId: text(row, 'key'),
        title: text(row, 'title'),
        usd: number(row, 'usd'),
      })),
      daily: daily.map((row) => ({ day: text(row, 'day'), usd: number(row, 'usd') })),
    };
  }
}

function toAcceptanceRecord(row: Row): AcceptanceRecord {
  return {
    taskId: text(row, 'task_id'),
    criterionId: text(row, 'criterion_id'),
    verdict: text(row, 'verdict') as AcceptanceRecord['verdict'],
    evidenceIds: parseJson<string[]>(row.evidence_ids, []),
    judgedBy: text(row, 'judged_by') as AcceptanceRecord['judgedBy'],
    judgedByUser: nullableText(row, 'judged_by_user') ?? undefined,
    note: nullableText(row, 'note') ?? undefined,
    at: number(row, 'at'),
  };
}

function toEvidence(row: Row): Evidence {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    criterionId: text(row, 'criterion_id'),
    kind: text(row, 'kind') as Evidence['kind'],
    ref: text(row, 'ref'),
    digest: text(row, 'digest'),
    producedBy: text(row, 'produced_by') as Evidence['producedBy'],
    createdAt: number(row, 'created_at'),
  };
}

function toTaskInput(row: Row): TaskInput {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    source: text(row, 'source') as TaskInput['source'],
    text: text(row, 'text'),
    state: text(row, 'state') as TaskInput['state'],
    createdAt: number(row, 'created_at'),
    deliveredAt: nullableText(row, 'delivered_at') === null
      ? undefined
      : number(row, 'delivered_at'),
  };
}

function toSupervisionAction(row: Row): SupervisionAction {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    workerId: nullableText(row, 'worker_id'),
    rule: text(row, 'rule') as SupervisionAction['rule'],
    verdict: text(row, 'verdict') as SupervisionAction['verdict'],
    reason: text(row, 'reason'),
    at: number(row, 'at'),
  };
}

function mapRun(row: Row): Run {
  return {
    id: text(row, 'id'),
    workerId: text(row, 'worker_id'),
    taskId: text(row, 'task_id'),
    attempt: number(row, 'attempt'),
    status: text(row, 'status') as RunStatus,
    leaseOwner: nullableText(row, 'lease_owner'),
    leaseExpiresAt: nullableNumber(row, 'lease_expires_at'),
    lastHeartbeatAt: nullableNumber(row, 'last_heartbeat_at'),
    startedAt: number(row, 'started_at'),
    endedAt: nullableNumber(row, 'ended_at'),
    error: nullableText(row, 'error'),
    recoveredUnknown: number(row, 'recovered_unknown') === 1,
  };
}

function mapMandate(row: Row): TaskMandate {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    capabilities: parseJson(row.capabilities_json, []),
    root: text(row, 'root'),
    roles: parseJson(row.roles_json, []),
    budget: parseJson(row.budget_json, {}),
    expiresAt: number(row, 'expires_at'),
    issuedBy: text(row, 'issued_by') as TaskMandate['issuedBy'],
    issuedAt: number(row, 'issued_at'),
  };
}

function mapSideEffect(row: Row): SideEffect {
  return {
    id: text(row, 'id'),
    taskId: text(row, 'task_id'),
    workerId: nullableText(row, 'worker_id'),
    runId: nullableText(row, 'run_id'),
    kind: text(row, 'kind') as SideEffectKind,
    target: text(row, 'target'),
    idempotencyKey: text(row, 'idempotency_key'),
    reversible: number(row, 'reversible') !== 0,
    state: text(row, 'state') as SideEffectState,
    result: nullableText(row, 'result'),
    createdAt: number(row, 'created_at'),
    updatedAt: number(row, 'updated_at'),
  };
}
