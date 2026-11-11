/**
 * 四层结构的持久化库：domain 表之上的一层薄封装。
 *
 * 铁律：**这里存的是事实，不是队列**。并发闸门的 running 集合活在内存里，
 * 二者刻意不合并——否则重启就会残留一堆永不推进的 running。
 */
import {
  BAO_COMPATIBLE_VERSIONS,
  BAO_DOMAIN_NAME,
  BAO_DOMAIN_VERSION,
  ExecutorRowSchema,
  ProjectRowSchema,
  ReportRowSchema,
  TurnRowSchema,
  isExecutorTerminal,
  newId,
  normalizeRootPath,
  nowIso,
  type ExecutorRow,
  type ExecutorStatus,
  type ProjectRow,
  type ReportKind,
  type ReportRow,
  type TurnJudgment,
  type TurnRow,
  type TurnSource,
} from './domain.js';
import type { DomainLike, KvTableLike, StorageDomainFacilityLike } from './host.js';

/** 极小 zod 兼容面：只要求 parse，便于单测注入假实现。 */
export interface ZodLike<T> {
  parse(value: unknown): T;
}

export interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly compatibleVersions?: readonly number[];
  readonly tables: Record<string, { readonly valueSchema: ZodLike<unknown> }>;
}

/** 与 dsh `defineDomain` 同名同参的声明辅助，避免在无宿主环境下也依赖上游包。 */
export function declareBaoDomain(): DomainSpecLike {
  return {
    name: BAO_DOMAIN_NAME,
    version: BAO_DOMAIN_VERSION,
    compatibleVersions: BAO_COMPATIBLE_VERSIONS,
    tables: {
      project: { valueSchema: ProjectRowSchema },
      executor: { valueSchema: ExecutorRowSchema },
      turn: { valueSchema: TurnRowSchema },
      report: { valueSchema: ReportRowSchema },
    },
  };
}

export interface BaoStore {
  readonly projects: KvTableLike<ProjectRow>;
  readonly executors: KvTableLike<ExecutorRow>;
  readonly turns: KvTableLike<TurnRow>;
  readonly reports: KvTableLike<ReportRow>;
  close(): Promise<void>;
}

export async function openBaoStore(facility: StorageDomainFacilityLike): Promise<BaoStore> {
  const domain = (await facility.open(declareBaoDomain())) as DomainLike;
  return {
    projects: domain.table('project') as unknown as KvTableLike<ProjectRow>,
    executors: domain.table('executor') as unknown as KvTableLike<ExecutorRow>,
    turns: domain.table('turn') as unknown as KvTableLike<TurnRow>,
    reports: domain.table('report') as unknown as KvTableLike<ReportRow>,
    close: () => domain.close(),
  };
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

export interface EnsureProjectOptions {
  readonly rootPath: string;
  readonly name?: string;
  readonly assistantPreset: string;
}

/**
 * 按归一化根路径 upsert 项目。同一路径永远得到同一个项目 id——
 * 这是"多项目不串台"的前提。
 *
 * 新建项目时 `assistantSessionId` 为空，由 project manager 建好 C 后回填。
 */
export async function ensureProject(
  store: BaoStore,
  options: EnsureProjectOptions,
): Promise<ProjectRow> {
  const normalized = normalizeRootPath(options.rootPath);
  if (!normalized) {
    throw new Error('项目路径不能为空');
  }
  for (const [, project] of store.projects.entries()) {
    if (project.rootPath === normalized && project.archived === 0) {
      return project;
    }
  }
  const now = nowIso();
  const row: ProjectRow = {
    id: newId('prj'),
    name: options.name?.trim() || lastSegment(normalized),
    rootPath: normalized,
    assistantSessionId: null,
    assistantPreset: options.assistantPreset,
    assistantRestored: 0,
    createdAt: now,
    updatedAt: now,
    archived: 0,
  };
  await store.projects.put(row.id, row);
  return row;
}

function lastSegment(normalized: string): string {
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function getProject(store: BaoStore, id: string): ProjectRow | undefined {
  return store.projects.get(id);
}

export function getProjectByPath(store: BaoStore, rootPath: string): ProjectRow | undefined {
  const normalized = normalizeRootPath(rootPath);
  for (const [, project] of store.projects.entries()) {
    if (project.rootPath === normalized && project.archived === 0) return project;
  }
  return undefined;
}

export function listProjects(store: BaoStore): ProjectRow[] {
  return [...store.projects.entries()]
    .map(([, p]) => p)
    .filter((p) => p.archived === 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function patchProject(
  store: BaoStore,
  id: string,
  patch: Partial<ProjectRow>,
): Promise<ProjectRow> {
  return store.projects.update(id, (current) => ({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  }));
}

// ---------------------------------------------------------------------------
// 执行者 D
// ---------------------------------------------------------------------------

export interface CreateExecutorInput {
  readonly projectId: string;
  readonly label: string;
  readonly goal: string;
  readonly writeScope?: string;
}

export async function createExecutor(
  store: BaoStore,
  input: CreateExecutorInput,
): Promise<ExecutorRow> {
  const now = nowIso();
  const row: ExecutorRow = {
    id: newId('exe'),
    projectId: input.projectId,
    sessionId: null,
    label: input.label.trim(),
    goal: input.goal.trim(),
    status: 'starting',
    resumable: 0,
    writeScope: input.writeScope?.trim() ?? '',
    summary: null,
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  await store.executors.put(row.id, row);
  return row;
}

export function getExecutor(store: BaoStore, id: string): ExecutorRow | undefined {
  return store.executors.get(id);
}

export interface ListExecutorsFilter {
  readonly projectId?: string;
  readonly status?: readonly ExecutorStatus[];
  readonly limit?: number;
}

export function listExecutors(
  store: BaoStore,
  filter: ListExecutorsFilter = {},
): ExecutorRow[] {
  const rows = [...store.executors.entries()]
    .map(([, e]) => e)
    .filter((e) => (filter.projectId ? e.projectId === filter.projectId : true))
    .filter((e) => (filter.status?.length ? filter.status.includes(e.status) : true));
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return filter.limit && filter.limit > 0 ? rows.slice(0, filter.limit) : rows;
}

/** 某个项目里仍在跑的 D（用于并行度与写域互斥判断）。 */
export function listActiveExecutors(store: BaoStore, projectId: string): ExecutorRow[] {
  return listExecutors(store, { projectId }).filter((e) => !isExecutorTerminal(e.status));
}

export async function patchExecutor(
  store: BaoStore,
  id: string,
  patch: Partial<ExecutorRow>,
): Promise<ExecutorRow> {
  return store.executors.update(id, (current) => ({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  }));
}

/** 进入终态并打上结束时间。重复调用保持首个 endedAt，便于统计耗时。 */
export async function finishExecutor(
  store: BaoStore,
  id: string,
  status: Extract<ExecutorStatus, 'done' | 'failed' | 'cancelled'>,
  extra: { summary?: string | null; blockedReason?: string | null } = {},
): Promise<ExecutorRow> {
  const now = nowIso();
  return store.executors.update(id, (current) => ({
    ...current,
    status,
    summary: extra.summary !== undefined ? extra.summary : current.summary,
    blockedReason: extra.blockedReason !== undefined ? extra.blockedReason : current.blockedReason,
    endedAt: current.endedAt ?? now,
    updatedAt: now,
  }));
}

/**
 * 重启恢复：把上次残留的 `starting` / `running` 改回可重新派发的状态。
 * 子代理随进程一起死了，`running` 是上一世的记忆，不承认它继续有效。
 *
 * 注意：C 本身由 project manager 恢复（D5），这里只处理 D。
 */
export async function recoverStaleExecutors(store: BaoStore): Promise<ExecutorRow[]> {
  const stale = listExecutors(store, { status: ['starting', 'running'] });
  const now = nowIso();
  for (const executor of stale) {
    await store.executors.update(executor.id, (current) => ({
      ...current,
      status: 'failed',
      blockedReason: '上次执行被中断（进程重启），需要重新派活',
      resumable: 0,
      endedAt: current.endedAt ?? now,
      updatedAt: now,
    }));
  }
  return stale;
}

// ---------------------------------------------------------------------------
// 对话轮
// ---------------------------------------------------------------------------

export interface CreateTurnInput {
  readonly projectId: string;
  readonly role: TurnRow['role'];
  readonly source: TurnSource;
  readonly text: string;
  readonly executorId?: string | null;
  readonly judged?: TurnJudgment | null;
}

export async function createTurn(store: BaoStore, input: CreateTurnInput): Promise<TurnRow> {
  const row: TurnRow = {
    id: newId('turn'),
    projectId: input.projectId,
    role: input.role,
    source: input.source,
    executorId: input.executorId ?? null,
    text: input.text,
    judged: input.judged ?? null,
    createdAt: nowIso(),
  };
  await store.turns.put(row.id, row);
  return row;
}

/** 补记冲突判定结论，让"C 判错了"可审计。方案 §5.2。 */
export async function judgeTurn(
  store: BaoStore,
  id: string,
  judged: TurnJudgment,
): Promise<TurnRow | undefined> {
  if (!store.turns.get(id)) return undefined;
  return store.turns.update(id, (current) => ({ ...current, judged }));
}

export function listTurns(store: BaoStore, projectId: string, limit = 200): TurnRow[] {
  const rows = [...store.turns.entries()]
    .map(([, t]) => t)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return limit > 0 ? rows.slice(-limit) : rows;
}

// ---------------------------------------------------------------------------
// 汇报
// ---------------------------------------------------------------------------

export interface CreateReportInput {
  readonly projectId: string;
  readonly executorId?: string | null;
  readonly kind: ReportKind;
  readonly body: string;
  readonly needsUser?: boolean;
}

export async function createReport(
  store: BaoStore,
  input: CreateReportInput,
  maxChars: number,
): Promise<ReportRow> {
  const row: ReportRow = {
    id: newId('rpt'),
    projectId: input.projectId,
    executorId: input.executorId ?? null,
    kind: input.kind,
    body: truncate(input.body, maxChars),
    needsUser: input.needsUser ? 1 : 0,
    createdAt: nowIso(),
    ackedAt: null,
  };
  await store.reports.put(row.id, row);
  return row;
}

export function listReports(store: BaoStore, projectId: string): ReportRow[] {
  return [...store.reports.entries()]
    .map(([, r]) => r)
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 待用户决策的汇报，按时间倒序，供看板与汇总使用。 */
export function listPendingReports(store: BaoStore, limit = 50): ReportRow[] {
  return [...store.reports.entries()]
    .map(([, r]) => r)
    .filter((r) => r.needsUser === 1 && r.ackedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n…（已截断 ${omitted} 字）`;
}
