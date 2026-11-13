/**
 * 侧栏的批次分组。
 *
 * ## 为什么需要
 *
 * 对话流里有批次线（签名元素），能看出"这一批是同一轮派的"。
 * 但**侧栏看不出来**——同一个项目下的会话排成一长条，分不清
 * 哪几个是并发派的、哪些是不同时间单独派的。
 *
 * ## 怎么标
 *
 * 不用大改结构，只给同一批的会话加一个「连续且同批」的标记：
 * - `first`：这一批的第一个（上方画一条分组起始线）
 * - `middle`：批次中间
 * - `last`：批次最后一个（下方画结束线）
 *
 * 单个会话的"批次"不算批——不画任何装饰。
 */
import { BATCH_WINDOW_MS } from './batches.js';
import type { ExecutorDto } from '../api.js';

export type BatchPosition = 'none' | 'first' | 'middle' | 'last';

export interface SidebarGroupInfo {
  /** 在批次里的位置。 */
  readonly position: BatchPosition;
  /** 这一批有几个 Agent（用于提示）。 */
  readonly batchSize: number;
}

/**
 * 给一组会话算出批次位置。
 *
 * 输入是**侧栏里显示的顺序**（已按 project 过滤），输出与输入一一对应。
 *
 * 判定规则和对话流的批次线一致：按 `createdAt` 排序后，
 * 相邻两个间隔 ≤ BATCH_WINDOW_MS 就归为一批。
 */
export function computeBatchPositions(executors: readonly ExecutorDto[]): SidebarGroupInfo[] {
  if (executors.length === 0) return [];

  // 按创建时间排——侧栏的显示顺序可能不是时间序，判定要按时间
  const sorted = [...executors].sort((a, b) => a.createdAt - b.createdAt);

  // 先算出每个会话所属的批次编号
  const batchOf = new Map<string, number>();
  let batchId = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0) {
      const gap = sorted[i]!.createdAt - sorted[i - 1]!.createdAt;
      if (gap > BATCH_WINDOW_MS) batchId += 1;
    }
    batchOf.set(sorted[i]!.id, batchId);
  }

  // 统计每批的大小
  const sizeOf = new Map<number, number>();
  for (const id of batchOf.values()) sizeOf.set(id, (sizeOf.get(id) ?? 0) + 1);

  // 按传入顺序输出
  return executors.map((executor) => {
    const id = batchOf.get(executor.id) ?? 0;
    const size = sizeOf.get(id) ?? 1;

    // 只有 1 个的"批次"不画装饰——强调"批"反而制造噪音
    if (size < 2) return { position: 'none', batchSize: 1 };

    const members = sorted.filter((e) => batchOf.get(e.id) === id);
    const index = members.findIndex((e) => e.id === executor.id);

    let position: BatchPosition = 'middle';
    if (index === 0) position = 'first';
    else if (index === members.length - 1) position = 'last';

    return { position, batchSize: size };
  });
}
