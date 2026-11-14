/**
 * 检查点：把一轮 Agent 工作里的所有文件改动聚成一组，支持整轮回滚。
 *
 * ## 和现有能力的关系
 *
 * 已经有的是**单次撤销**（`undo.ts` + `snapshot.ts`）：
 * 一个副作用 id → 恢复一个文件。
 *
 * 缺的是**轮次级回滚**：这一轮 Agent 改了 8 个文件，
 * 用户想整体退回"它开始干活之前"，而不是点 8 次。
 *
 * ## 为什么不用新的存储
 *
 * 台账（`SideEffectRow`）已经记了 `executorId` + `createdAt`，
 * 快照也已经按副作用 id 存好了。
 *
 * **检查点 = 一个时间窗 + 一组副作用 id**，不需要新表、不需要新目录。
 * 这是最小改动，也是最少出错的设计。
 *
 * ## 回滚的关键约束（继承自 undo.ts）
 *
 * 任何一个文件在 Agent 改完之后**又被改过**，就跳过那个文件并如实报告，
 * **不静默覆盖**。整轮回滚不能变成"把你后来的手工修改也吃掉"。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SnapshotStore } from './snapshot.js';
import type { SideEffectRow } from '../store/store.js';
import { undoFileWrite } from './undo.js';

/** 一个检查点：某次 Agent 运行期间的一批文件改动。 */
export interface Checkpoint {
  /** 稳定的标识（执行器 id + 起始时间），用于界面引用。 */
  readonly id: string;
  readonly executorId: string;
  /** 这一轮的起止时间（毫秒）。 */
  readonly from: number;
  readonly to: number;
  /** 这一轮改了什么文件（去重后的相对路径）。 */
  readonly files: readonly string[];
  /** 其中有多少是可回滚的。 */
  readonly reversibleCount: number;
}

/**
 * 从台账里取出某次执行器的所有文件写入，按时间聚成检查点。
 *
 * 聚法：**相邻两次写之间超过 `gapMs` 就切开**。
 * 为什么不用"每次运行一个检查点"——执行器可能连续跑很久，
 * 中间用户可能已经手动改过文件；切得细一点，回滚粒度更安全。
 */
export function buildCheckpoints(
  rows: readonly SideEffectRow[],
  options: { executorId: string; gapMs?: number },
): Checkpoint[] {
  const gap = options.gapMs ?? 10 * 60_000; // 10 分钟

  const writes = rows
    .filter((r) => r.executorId === options.executorId)
    .filter((r) => r.kind === 'fs.write')
    .sort((a, b) => a.createdAt - b.createdAt);

  if (writes.length === 0) return [];

  const groups: SideEffectRow[][] = [];
  let current: SideEffectRow[] = [];
  for (const row of writes) {
    const prev = current[current.length - 1];
    if (prev && row.createdAt - prev.createdAt > gap) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const files = [...new Set(group.map((r) => r.target))];
    return {
      id: `${options.executorId}@${first.createdAt}`,
      executorId: options.executorId,
      from: first.createdAt,
      to: last.createdAt,
      files,
      reversibleCount: group.filter((r) => r.reversible).length,
    };
  });
}

export interface RollbackOutcome {
  /** 恢复成功的文件。 */
  readonly restored: readonly string[];
  /** 跳过的文件及原因。 */
  readonly skipped: readonly { path: string; reason: string }[];
  /** 给用户看的一句话总结。 */
  readonly message: string;
}

/**
 * 回滚一个检查点：把这一轮改过的文件都恢复到改动前。
 *
 * @param rows 台账里的全部副作用（内部按 checkpoint 时间窗筛选）
 */
export async function rollbackCheckpoint(input: {
  readonly snapshot: SnapshotStore;
  readonly rootPath: string;
  readonly rows: readonly SideEffectRow[];
  readonly checkpoint: Checkpoint;
}): Promise<RollbackOutcome> {
  const inWindow = input.rows.filter(
    (r) =>
      r.executorId === input.checkpoint.executorId &&
      r.kind === 'fs.write' &&
      r.createdAt >= input.checkpoint.from &&
      r.createdAt <= input.checkpoint.to,
  );

  if (inWindow.length === 0) {
    return { restored: [], skipped: [], message: '这个检查点里没有可回滚的文件改动。' };
  }

  const restored: string[] = [];
  const skipped: { path: string; reason: string }[] = [];

  // **同一文件多次改动**：要按时间**倒序**回滚，
  // 否则先恢复到最早版本，后面的快照就对不上了。
  const ordered = [...inWindow].sort((a, b) => b.createdAt - a.createdAt);

  const done = new Set<string>();

  for (const row of ordered) {
    if (!row.reversible) {
      skipped.push({ path: row.target, reason: '这类动作不可回滚' });
      continue;
    }
    // 同一个文件只回滚一次（用最后一次的期望内容比对）
    if (done.has(row.target)) continue;
    done.add(row.target);

    // "Agent 改完之后应该是什么"——取同一文件最后一条记录的参数
    const expected = expectedContentFor(ordered, row.target);

    const r = await undoFileWrite({
      snapshot: input.snapshot,
      rootPath: input.rootPath,
      sideEffectId: row.id,
      relativePath: row.target,
      ...(expected !== undefined ? { expectedContent: expected } : {}),
    });

    if (r.ok) restored.push(row.target);
    else skipped.push({ path: row.target, reason: r.message.split('\n')[0] ?? '回滚失败' });
  }

  const parts: string[] = [];
  if (restored.length > 0) parts.push(`已恢复 ${restored.length} 个文件`);
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个`);

  return {
    restored,
    skipped,
    message: parts.length > 0 ? `${parts.join('，')}。` : '没有需要回滚的文件。',
  };
}

/**
 * 从台账参数里挖出"写入之后的内容"。
 *
 * 参数是截断存储的 JSON；挖不到就返回 undefined（不做"之后又被改过"的检测）。
 */
function expectedContentFor(rows: readonly SideEffectRow[], target: string): string | undefined {
  const last = rows.find((r) => r.target === target);
  if (!last) return undefined;
  try {
    const parsed = JSON.parse(last.args) as { content?: unknown; new_text?: unknown };
    if (typeof parsed.content === 'string') return parsed.content;
    // edit_file 记的是 new_text——它不是完整内容，不能用来整体比对
    return undefined;
  } catch {
    return undefined;
  }
}

/** 读当前文件内容，方便调用方判断要不要回滚。 */
export async function currentContent(rootPath: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.resolve(rootPath, relativePath), 'utf8');
  } catch {
    return null;
  }
}
