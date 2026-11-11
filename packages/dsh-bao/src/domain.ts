/**
 * @opencoxswain/dsh-bao —— 持久化域定义（四层结构）。
 *
 * 权威方案：docs/self-developed-plan.md §5。四张表对应四个角色：
 *
 * | 表 | 角色 | 一句话 |
 * | --- | --- | --- |
 * | `project` | 项目 + C | 一个工作目录 + 一个常驻项目助理会话 |
 * | `executor` | D | 执行者，一事一 D，可被用户追问 |
 * | `turn` | 用户消息 | 用来留痕"冲突判定"与用户直连 D |
 * | `report` | C 的汇报 | 每一条向用户的汇报，先完成先报 |
 *
 * 设计铁律：
 * - 这些表存的是**事实**，不是队列。并发闸门的 running 集合活在内核内存里，
 *   二者刻意不合并，否则重启会残留一堆永不推进的 running。
 * - 新增字段一律 optional，并把旧版本号写进 `compatibleVersions`，
 *   这样已存在的记录不会被判成 invalid-record。
 */
import { z } from 'zod';

/** 执行者（D）状态机。方案 §5.1 `ExecutorRow.status`。 */
export const EXECUTOR_STATUSES = [
  'starting',
  'running',
  'idle',
  'done',
  'failed',
  'cancelled',
] as const;
export type ExecutorStatus = (typeof EXECUTOR_STATUSES)[number];

/** D 处于这些状态时不再占用并发槽位。 */
export const EXECUTOR_TERMINAL_STATUSES: readonly ExecutorStatus[] = [
  'done',
  'failed',
  'cancelled',
];

/** 用户消息被 C 判定成什么。方案 §4 / §5.1 `TurnRow.judged`。 */
export const TURN_JUDGMENTS = ['new', 'parallel', 'conflict'] as const;
export type TurnJudgment = (typeof TURN_JUDGMENTS)[number];

export const TURN_SOURCES = ['webapp', 'im', 'assistant', 'executor'] as const;
export type TurnSource = (typeof TURN_SOURCES)[number];

export const REPORT_KINDS = ['progress', 'blocked', 'done', 'failed', 'question'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const isoDate = z.string().min(1);
const flag = z.union([z.literal(0), z.literal(1)]);

// ---------------------------------------------------------------------------
// 项目：一个工作目录 + 一个常驻 C
// ---------------------------------------------------------------------------

export const ProjectRowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 归一化后的项目根目录（小写、正斜杠、无尾斜杠）。 */
  rootPath: z.string().min(1),
  /**
   * C 的会话 id。**整个架构的锚点**：有它，B 和用户都能找到这个项目的 C；
   * 没它，C 就是一条找不到入口的孤儿会话。方案 §5.2。
   */
  assistantSessionId: z.string().nullable(),
  /** C 用哪个 preset，默认 project-assistant。 */
  assistantPreset: z.string().min(1),
  /** C 的会话是否已成功恢复（D5：完整恢复）。重启后先 false，恢复成功置 true。 */
  assistantRestored: flag,
  createdAt: isoDate,
  updatedAt: isoDate,
  archived: flag,
});
export type ProjectRow = z.infer<typeof ProjectRowSchema>;

// ---------------------------------------------------------------------------
// 执行者 D
// ---------------------------------------------------------------------------

export const ExecutorRowSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** D 的子会话 id。 */
  sessionId: z.string().nullable(),
  label: z.string().min(1),
  /** 派给 D 的目标（可读版）。 */
  goal: z.string().min(1),
  status: z.enum(EXECUTOR_STATUSES),
  /**
   * D 跑完后能否被用户继续追问。
   * 依赖会话持久化与 sessionQuery；拿不准就是 0，UI 不许骗人。方案 §5.2。
   */
  resumable: flag,
  /**
   * 写域声明，用于并行冲突检测。空串表示"声明不了"——按方案 §7.2
   * 视为与所有写任务冲突，必须串行。
   */
  writeScope: z.string(),
  /** D 的收尾结论（来自结算通知）。 */
  summary: z.string().nullable(),
  /** 失败或被阻断的原因。 */
  blockedReason: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  endedAt: isoDate.nullable(),
});
export type ExecutorRow = z.infer<typeof ExecutorRowSchema>;

// ---------------------------------------------------------------------------
// 对话轮：留给"C 判错了"一个可审计的地方
// ---------------------------------------------------------------------------

export const TurnRowSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** 这条消息是用户发的，还是 C / D 产生的。 */
  role: z.enum(['user', 'assistant', 'system']),
  source: z.enum(TURN_SOURCES),
  /** 用户直连 D 时记下是哪个 D，用于 D3「C 知道」。 */
  executorId: z.string().nullable(),
  text: z.string(),
  /** 用户消息被判定为：新增 / 与在跑任务并列 / 与在跑任务冲突。 */
  judged: z.enum(TURN_JUDGMENTS).nullable(),
  createdAt: isoDate,
});
export type TurnRow = z.infer<typeof TurnRowSchema>;

// ---------------------------------------------------------------------------
// 汇报：C 向用户汇报的每一条
// ---------------------------------------------------------------------------

export const ReportRowSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  executorId: z.string().nullable(),
  kind: z.enum(REPORT_KINDS),
  body: z.string(),
  /** 是否需要用户拍板。 */
  needsUser: flag,
  createdAt: isoDate,
  ackedAt: isoDate.nullable(),
});
export type ReportRow = z.infer<typeof ReportRowSchema>;

// ---------------------------------------------------------------------------
// 域声明
// ---------------------------------------------------------------------------

export const BAO_DOMAIN_NAME = 'bao';
/**
 * v2：从"任务"模型（task）改为四层结构（executor / turn / report / project）。
 * 旧的 v1 表不进 compatibleVersions —— M0 的两层模型已被方案 §0 判为方向偏差，
 * 不复用其数据。
 */
export const BAO_DOMAIN_VERSION = 2;
export const BAO_COMPATIBLE_VERSIONS: readonly number[] = [2];

/** 归一化路径，作为"同一项目"的唯一判据。 */
export function normalizeRootPath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isExecutorTerminal(status: ExecutorStatus): boolean {
  return EXECUTOR_TERMINAL_STATUSES.includes(status);
}
