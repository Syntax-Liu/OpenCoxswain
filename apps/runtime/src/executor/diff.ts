/**
 * 统一 diff（unified diff）。
 *
 * ## 为什么需要
 *
 * 现在 `edit_file` 和 `write_file` 都是**直接写出去**，改之前看不到
 * "会变成什么样"。Cursor / Cline 的逐行绿红高亮就是这个东西。
 *
 * ## 为什么不用第三方库
 *
 * 运行时是**零依赖**的，这是硬约束（`boundary.test.ts` 强制）。
 * 而统一 diff 本身不难：最长公共子序列 + 上下文行。
 *
 * ## 输出格式
 *
 * ```
 * --- a/src/foo.ts
 * +++ b/src/foo.ts
 * @@ -12,3 +12,4 @@
 *  const a = 1;
 * -const b = 2;
 * +const b = 3;
 * +const c = 4;
 *  const d = 5;
 * ```
 *
 * 和 `git diff` 一致，模型和用户都认得。
 */

/** 上下文行数（和 git 默认一致）。 */
const CONTEXT = 3;

/**
 * 最长公共子序列的匹配表。
 *
 * 用 Int32Array 打平，避免大文件时对象爆炸——几十万行的表
 * 用普通数组会吃掉几百 MB。
 */
function lcsTable(a: readonly string[], b: readonly string[]): Int32Array {
  const n = a.length;
  const m = b.length;
  const table = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const idx = i * (m + 1) + j;
      table[idx] =
        a[i] === b[j]
          ? (table[(i + 1) * (m + 1) + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * (m + 1) + j] ?? 0, table[i * (m + 1) + (j + 1)] ?? 0);
    }
  }
  return table;
}

type Op = { kind: 'same' | 'del' | 'add'; text: string };

/** 把两段文本对齐成编辑脚本。 */
function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * (m + 1) + j] ?? 0) >= (table[i * (m + 1) + (j + 1)] ?? 0)) {
      ops.push({ kind: 'del', text: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', text: a[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'add', text: b[j]! });
    j += 1;
  }
  return ops;
}

/** 把编辑脚本切成 hunk，只保留变更附近 CONTEXT 行。 */
function hunks(ops: readonly Op[]): { ops: Op[]; oldStart: number; oldCount: number; newStart: number; newCount: number }[] {
  const out: { ops: Op[]; oldStart: number; oldCount: number; newStart: number; newCount: number }[] = [];

  // 先标出哪些行要保留（变更行 + 前后 CONTEXT）
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k]!.kind === 'same') continue;
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(ops.length - 1, k + CONTEXT);
    for (let x = from; x <= to; x += 1) keep[x] = true;
  }

  let k = 0;
  while (k < ops.length) {
    if (!keep[k]) { k += 1; continue; }

    // 收集一段连续的保留区
    let end = k;
    while (end + 1 < ops.length && keep[end + 1]) end += 1;

    // 计算起始行号（1-based）
    let oldLine = 1;
    let newLine = 1;
    for (let x = 0; x < k; x += 1) {
      if (ops[x]!.kind === 'same' || ops[x]!.kind === 'del') oldLine += 1;
      if (ops[x]!.kind === 'same' || ops[x]!.kind === 'add') newLine += 1;
    }

    const slice = ops.slice(k, end + 1);
    out.push({
      ops: slice,
      oldStart: oldLine,
      oldCount: slice.filter((o) => o.kind === 'same' || o.kind === 'del').length,
      newStart: newLine,
      newCount: slice.filter((o) => o.kind === 'same' || o.kind === 'add').length,
    });

    k = end + 1;
  }

  return out;
}

export interface DiffOptions {
  /** 显示用的文件名（默认分别是 a/... 和 b/...）。 */
  readonly path?: string;
  /** 最多输出多少行，超出截断（防止大文件把上下文撑爆）。 */
  readonly maxLines?: number;
}

export interface DiffResult {
  readonly text: string;
  /** 新增行数。 */
  readonly added: number;
  /** 删除行数。 */
  readonly removed: number;
  /** 是否因为太长被截断。 */
  readonly truncated: boolean;
}

/**
 * 生成统一 diff。
 *
 * 两段文本相同 → 返回空 text（调用方可据此判断"没有变化"）。
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: DiffOptions = {},
): DiffResult {
  if (before === after) {
    return { text: '', added: 0, removed: 0, truncated: false };
  }

  const a = before.split('\n');
  const b = after.split('\n');
  // **末尾换行不算一行**：`"a\n"` split 出来是 `['a', '']`，
  // 那个空串是换行符的产物，不是真实的行。
  // git diff 也这么处理（否则每个文件都会多出一行空行）。
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const ops = diffOps(a, b);

  const added = ops.filter((o) => o.kind === 'add').length;
  const removed = ops.filter((o) => o.kind === 'del').length;

  const path = options.path ?? 'file';
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];

  for (const h of hunks(ops)) {
    lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`);
    for (const o of h.ops) {
      const prefix = o.kind === 'same' ? ' ' : o.kind === 'del' ? '-' : '+';
      lines.push(`${prefix}${o.text}`);
    }
  }

  const max = options.maxLines ?? 400;
  if (lines.length > max) {
    const kept = lines.slice(0, max);
    kept.push(`…（diff 太长，已截断：共 ${lines.length} 行）`);
    return { text: kept.join('\n'), added, removed, truncated: true };
  }

  return { text: lines.join('\n'), added, removed, truncated: false };
}

/** 一行摘要，比如 `+3 -1`。 */
export function diffStat(result: DiffResult): string {
  if (result.added === 0 && result.removed === 0) return '无变化';
  return `+${result.added} -${result.removed}`;
}
