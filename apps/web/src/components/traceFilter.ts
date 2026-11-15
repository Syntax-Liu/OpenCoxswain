/**
 * 轨迹筛选。
 *
 * ## 为什么需要
 *
 * 一个跑了几十步的 Agent，轨迹页有上百条记录。排查问题时最常问的是：
 * **"哪一步失败了"**——现在只能靠肉眼看。
 *
 * ## 三类筛子
 *
 * | 筛子 | 场景 |
 * | --- | --- |
 * | 全部 | 从头看一遍发生了什么 |
 * | 只看失败 | 排查问题 |
 * | 只看写操作 | 核对它到底改了什么 |
 *
 * ## 一个设计判断：失败包括"被拒绝"
 *
 * 审批被拒绝、沙箱拦截，这些**不是错误但也不是成功**——
 * 排查"为什么没做成"时必须看到它们。
 */
import type { TraceEntry, TraceKind } from './trace.js';

export type TraceFilter = 'all' | 'failed' | 'writes';

export interface TraceFilterOption {
  readonly id: TraceFilter;
  readonly label: string;
}

/** 界面上显示的筛选项。 */
export const TRACE_FILTERS: readonly TraceFilterOption[] = [
  { id: 'all', label: '全部' },
  { id: 'failed', label: '只看失败' },
  { id: 'writes', label: '只看写操作' },
];

/**
 * 判断一条记录是不是"失败"。
 *
 * 包括：工具报错、被拒绝、被拦截。
 * **都算失败**——用户关心的是"这一步没成"，不关心为什么没成。
 */
export function isFailedEntry(entry: TraceEntry): boolean {
  const text = `${entry.title} ${entry.detail}`.toLowerCase();
  return (
    text.includes('失败') ||
    text.includes('错误') ||
    text.includes('被拒绝') ||
    text.includes('拦截') || // "已被拦截"/"被沙箱拦住" 都算
    text.includes('未获批准') ||
    text.includes('没有执行') ||
    text.includes('error') ||
    text.includes('failed') ||
    text.includes('rejected')
  );
}

/** 判断一条记录是不是写操作。 */
export function isWriteEntry(entry: TraceEntry): boolean {
  const text = `${entry.title} ${entry.detail}`;
  return (
    text.includes('write_file') ||
    text.includes('edit_file') ||
    text.includes('run_command') ||
    (entry.kind as TraceKind) === 'tool'
  );
}

/**
 * 按筛子过滤。
 *
 * 顺序：先按筛子，再按搜索词——两者可以叠加。
 */
export function filterTrace(
  entries: readonly TraceEntry[],
  filter: TraceFilter,
  query: string,
): TraceEntry[] {
  let out = [...entries];

  if (filter === 'failed') {
    out = out.filter(isFailedEntry);
  } else if (filter === 'writes') {
    out = out.filter(isWriteEntry);
  }

  const q = query.trim().toLowerCase();
  if (q) {
    out = out.filter(
      (e) => e.title.toLowerCase().includes(q) || e.detail.toLowerCase().includes(q),
    );
  }

  return out;
}

/** 统计每类有多少条（用于在筛选项上显示数字）。 */
export function countByFilter(entries: readonly TraceEntry[]): Record<TraceFilter, number> {
  return {
    all: entries.length,
    failed: entries.filter(isFailedEntry).length,
    writes: entries.filter(isWriteEntry).length,
  };
}
