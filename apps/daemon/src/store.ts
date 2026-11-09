import { DatabaseSync } from 'node:sqlite';
import {
  newId,
  now,
  type AcceptanceResult,
  type Approval,
  type ArtifactRecord,
  type Assistant,
  type CostLedger,
  type EventRecord,
  type Message,
  type Project,
  type ProjectCostReport,
  type Task,
  type TaskEdge,
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

CREATE TABLE task_acceptance (
  task_id      TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  status       TEXT NOT NULL,
  evidence     TEXT,
  judged_by    TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (task_id, criterion_id)
);

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
    if (version >= 1) return;
    this.db.exec('BEGIN;');
    try {
      this.db.exec(SCHEMA);
      this.db.exec('PRAGMA user_version = 1;');
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
  }): Project {
    const project: Project = {
      id: newId('prj'),
      name: input.name,
      path: input.path,
      defaultBranch: input.defaultBranch,
      dailyBudgetUsd: input.dailyBudgetUsd,
      maxConcurrency: input.maxConcurrency,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, path, default_branch, daily_budget_usd, max_concurrency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.path,
        project.defaultBranch,
        project.dailyBudgetUsd,
        project.maxConcurrency,
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
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  setTaskAssignee(id: string, assigneeId: string | null): void {
    this.db
      .prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?')
      .run(assigneeId, now(), id);
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
      .prepare('INSERT INTO runs (id, worker_id, attempt, started_at) VALUES (?, ?, ?, ?)')
      .run(id, workerId, attempt, now());
  }

  finishRun(id: string, result: WorkerResult | null, error: string | null): void {
    this.db
      .prepare('UPDATE runs SET ended_at = ?, result_json = ?, error = ? WHERE id = ?')
      .run(now(), result ? JSON.stringify(result) : null, error, id);
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

  // ---------- acceptance ----------

  setAcceptance(taskId: string, results: AcceptanceResult[]): void {
    const statement = this.db.prepare(
      `INSERT INTO task_acceptance (task_id, criterion_id, status, evidence, judged_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, criterion_id) DO UPDATE SET
         status = excluded.status,
         evidence = excluded.evidence,
         judged_by = excluded.judged_by,
         updated_at = excluded.updated_at`,
    );
    for (const result of results) {
      statement.run(
        taskId,
        result.criterionId,
        result.status,
        result.evidence ?? null,
        result.judgedBy,
        now(),
      );
    }
  }

  listAcceptance(taskId: string): AcceptanceResult[] {
    const rows = this.db
      .prepare('SELECT * FROM task_acceptance WHERE task_id = ? ORDER BY criterion_id ASC')
      .all(taskId) as Row[];
    return rows.map((row) => ({
      criterionId: text(row, 'criterion_id'),
      status: text(row, 'status') as AcceptanceResult['status'],
      evidence: nullableText(row, 'evidence') ?? undefined,
      judgedBy: text(row, 'judged_by') as AcceptanceResult['judgedBy'],
    }));
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
