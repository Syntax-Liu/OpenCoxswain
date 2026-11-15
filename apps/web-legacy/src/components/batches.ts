import type { ExecutorDto } from '../api.js';

/**
 * 批次：把同一轮派出的 Agent 归到一起。
 *
 * ## 为什么需要
 *
 * 这个产品最核心的机制是「一句话派出多个 Agent，谁先完成谁先报」。
 * 但界面上现在只有一条时间流水，看不出"这五个是一起派出去的"。
 *
 * 批次线把这个机制**变成看得见的结构**：
 *
 * ```
 * 你  重构登录页，顺便补测试
 * ══ 03:14 · 派出 3 个 ══════════════════
 *  ● 查依赖漏洞     完成   0:51   ← 先回来的在上
 *  ● 重构登录页     进行中 2:14
 *  ○ 补测试         排队     —
 * ```
 *
 * ## 怎么判定"同一批"
 *
 * 运行时没有显式的批次 ID，但 Assistant 派活是**一轮内连续调用**
 * `spawn_executor`，间隔通常几秒。所以用时间窗口聚类：
 * 相邻两个 Agent 的创建时间差小于阈值，就归入同一批。
 *
 * 为什么不用数据库加字段：那要迁移 schema，而且历史数据没有批次号，
 * 迁移后旧数据仍然要聚类。时间聚类对**新老数据都成立**。
 */

/** 同一批的时间窗口：派活之间的间隔通常只有几秒。 */
export const BATCH_WINDOW_MS = 90_000;

export interface Batch {
  /** 稳定标识：用第一个 Agent 的 id。 */
  readonly id: string;
  /** 这一批的派出时间（第一个 Agent 的创建时间）。 */
  readonly at: number;
  /** 这一批的 Agent，**按完成顺序排**（先完成的在上）。 */
  readonly agents: readonly ExecutorDto[];
}

export interface TaskLine {
  readonly agent: ExecutorDto;
  readonly label: string;
  readonly status: 'done' | 'running' | 'queued' | 'blocked';
  /** 时长文本；未结束时为 null。 */
  readonly duration: string | null;
}

const RUNNING = new Set(['running', 'starting']);

/** 把 Agent 列表按派出时间聚类成批次。 */
export function groupBatches(executors: readonly ExecutorDto[]): Batch[] {
  if (executors.length === 0) return [];

  const sorted = [...executors].sort((a, b) => a.createdAt - b.createdAt);
  const batches: Array<{ id: string; at: number; agents: ExecutorDto[] }> = [];

  for (const agent of sorted) {
    const last = batches[batches.length - 1];
    if (last && agent.createdAt - last.at <= BATCH_WINDOW_MS) {
      last.agents.push(agent);
    } else {
      batches.push({ id: agent.id, at: agent.createdAt, agents: [agent] });
    }
  }

  return batches.map((b) => ({ id: b.id, at: b.at, agents: sortByCompletion(b.agents) }));
}

/**
 * 批次内排序：**完成的排前面**。
 *
 * 这是产品的核心承诺（谁先完成谁先报）在界面上的体现。
 * 排序规则：
 * 1. 已完成的按结束时间升序（最早完成的在最上）
 * 2. 进行中的排在后面
 * 3. 排队的最后
 */
function sortByCompletion(agents: readonly ExecutorDto[]): ExecutorDto[] {
  const rank = (a: ExecutorDto): number => {
    if (a.endedAt !== null && !RUNNING.has(a.status)) return 0;
    if (RUNNING.has(a.status)) return 1;
    return 2;
  };

  return [...agents].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (a.endedAt ?? 0) - (b.endedAt ?? 0);
    return a.createdAt - b.createdAt;
  });
}

/** 单个 Agent → 任务行的展示数据。 */
export function toTaskLine(agent: ExecutorDto): TaskLine {
  // 真实状态只有五种：starting / running / done / failed / cancelled
  const status: TaskLine['status'] =
    agent.status === 'starting'
      ? 'queued' // 已派出、还没真正开跑
      : agent.status === 'running'
        ? 'running'
        : agent.endedAt !== null
          ? 'done'
          : 'queued';

  return {
    agent,
    label: agent.label,
    status,
    duration: agent.endedAt !== null ? formatShortDuration(agent.createdAt, agent.endedAt) : null,
  };
}

/** 批次时长文本：如 `0:51`、`2:14`、`1:02:03`。 */
export function formatShortDuration(startAt: number, endAt: number): string {
  const ms = Math.max(0, endAt - startAt);
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** 批次头的描述文本，例如「03:14 · 派出 3 个」。 */
export function describeBatch(batch: Batch): { time: string; summary: string } {
  const d = new Date(batch.at);
  const time = d.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const n = batch.agents.length;
  const done = batch.agents.filter((a) => a.endedAt !== null && !RUNNING.has(a.status)).length;

  const summary = done === n ? `${n} 个全部完成` : `${n} 个 · ${done} 个已完成`;
  return { time, summary };
}

/** 状态点样式名。 */
export function statusDotClass(status: TaskLine['status']): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'queued':
      return 'queued';
  }
}

/**
 * 哪些批次值得画线。
 *
 * **只派一个 Agent 不画**——那是普通派活，强调「批」反而制造噪音。
 * 批次线只在真的并发了多个任务时才有意义。
 */
export function isNotableBatch(batch: Batch): boolean {
  return batch.agents.length > 1;
}
