/**
 * 撤销：把文件恢复到一个副作用之前的状态。
 *
 * ## 一条最要紧的规则
 *
 * **如果文件在副作用之后又被改过，拒绝撤销。**
 *
 * 静默覆盖掉用户后来的手工修改，比不撤销糟得多——
 * 用户会以为"我撤销的是 Agent 的改动"，结果连自己改的一起没了。
 *
 * 所以每次撤销前都要比对：当前内容是否还等于"Agent 改完之后的样子"？
 * 不等就拒绝，并说清楚原因。
 *
 * ## 能撤销的只有文件写入
 *
 * 跑过的命令没法撤销——你不知道它到底改了什么。
 * 发出去的请求收不回来。这些在界面上标"不可撤销"，不给假承诺。
 */
import { readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { SnapshotStore } from './snapshot.js';

export type UndoRejectReason =
  | 'not-found'
  | 'no-snapshot'
  | 'not-reversible'
  | 'changed-after'
  | 'already-undone';

export interface UndoResult {
  readonly ok: boolean;
  /** 给用户看的一句话。 */
  readonly message: string;
  /** 失败时的原因分类。 */
  readonly reason?: UndoRejectReason;
}

/** 撤销一个文件写入。 */
export async function undoFileWrite(input: {
  readonly snapshot: SnapshotStore;
  readonly rootPath: string;
  readonly sideEffectId: string;
  readonly relativePath: string;
  /** Agent 改完之后，文件应该是什么内容。用于检测"之后又被改过"。 */
  readonly expectedContent?: string | null;
}): Promise<UndoResult> {
  const target = path.resolve(input.rootPath, input.relativePath);

  const snapshot = await input.snapshot.load(input.sideEffectId, input.relativePath);
  if (!snapshot) {
    return {
      ok: false,
      reason: 'no-snapshot',
      message: '找不到这个文件的原始内容，无法撤销。（可能改的是大文件，或快照已被清理）',
    };
  }

  // ---- 检测"之后又被改过" ----
  //
  // 只有知道 Agent 改成了什么，才能判断当前内容是不是它改的。
  // 没给 expectedContent 时跳过这一步（调用方没条件比对）。
  if (input.expectedContent !== undefined && input.expectedContent !== null) {
    let current: string | null = null;
    try {
      current = await readFile(target, 'utf8');
    } catch {
      current = null; // 文件被删了
    }

    if (current !== input.expectedContent) {
      return {
        ok: false,
        reason: 'changed-after',
        message:
          '这个文件在 Agent 改完之后又被修改过，撤销会覆盖掉后来的改动，所以没有执行。\n' +
          '如果确实要回到改动前，请手工处理。',
      };
    }
  }

  // ---- 执行 ----
  try {
    if (!snapshot.existed) {
      // 原来是新建的：撤销 = 删掉这个文件
      await rm(target, { force: true });
      return { ok: true, message: `已删除 Agent 新建的文件：${input.relativePath}` };
    }

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, snapshot.content ?? '', 'utf8');
    return { ok: true, message: `已恢复到改动前：${input.relativePath}` };
  } catch (error) {
    return {
      ok: false,
      message: `撤销失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 判断一个副作用类型能不能撤销。 */
export function isUndoable(kind: string, reversible: boolean): boolean {
  // 只有文件写入是真能撤销的。
  // 命令执行即使标了"可逆"也不撤销——我们不知道它到底改了什么。
  //
  // 注意 `fs.write` 是台账里的实际类型名（见 side-effect.ts 的 SideEffectKind），
  // 早期版本写的是 'write' / 'file-write'，对不上就会一律拒绝。
  return reversible && kind === 'fs.write';
}
