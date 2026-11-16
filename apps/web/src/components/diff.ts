/**
 * 行级差异：把"改之前"和"改之后"对齐成可并排显示的若干行。
 *
 * ## 为什么自己写
 *
 * 只需要**并排显示**这一种用途，不需要 patch 格式、不需要双向编辑。
 * 引一个 diff 库（几十 KB）为了这点事不值得——项目对第三方依赖是零。
 *
 * ## 算法
 *
 * 标准 LCS（最长公共子序列）动态规划。文件通常几百到几千行，
 * O(n×m) 完全够用；超过阈值就退化成"整段替换"，避免大文件卡死界面。
 */

/** 一行在并排视图里的样子。 */
export interface DiffLine {
  /** 左侧（改之前）的行号，没有则为 null。 */
  readonly leftNo: number | null;
  /** 右侧（改之后）的行号，没有则为 null。 */
  readonly rightNo: number | null;
  readonly left: string | null;
  readonly right: string | null;
  readonly kind: 'same' | 'add' | 'remove' | 'change';
}

/**
 * 超过这个行数就不做精细对齐。
 *
 * 2000×2000 的 DP 表要算 400 万格，浏览器里会有明显卡顿；
 * 而这么大的文件人也不会逐行看。
 */
const MAX_DP_LINES = 2000;

/** 按行切开。末尾的换行不该多出一个空行。 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 算出并排显示所需的行序列。
 *
 * @param before 改之前的内容（null = 文件当时不存在）
 * @param after  改之后的内容（null = 文件已被删除）
 */
export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);

  // 太大：不逐行对齐，整段替换。**如实**——用户看到的就是"全变了"。
  if (a.length > MAX_DP_LINES || b.length > MAX_DP_LINES) {
    const out: DiffLine[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      const left = i < a.length ? a[i]! : null;
      const right = i < b.length ? b[i]! : null;
      out.push({
        leftNo: left === null ? null : i + 1,
        rightNo: right === null ? null : i + 1,
        left,
        right,
        kind: left === null ? 'add' : right === null ? 'remove' : 'change',
      });
    }
    return out;
  }

  // LCS 表：dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // 顺着回溯，把"删"和"增"配对成 'change'——并排显示时一行对一行更好读
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let pendingRemoved: { no: number; text: string }[] = [];
  let pendingAdded: { no: number; text: string }[] = [];

  const flush = (): void => {
    const max = Math.max(pendingRemoved.length, pendingAdded.length);
    for (let k = 0; k < max; k += 1) {
      const r = pendingRemoved[k];
      const ad = pendingAdded[k];
      out.push({
        leftNo: r?.no ?? null,
        rightNo: ad?.no ?? null,
        left: r?.text ?? null,
        right: ad?.text ?? null,
        kind: r && ad ? 'change' : r ? 'remove' : 'add',
      });
    }
    pendingRemoved = [];
    pendingAdded = [];
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      out.push({ leftNo: i + 1, rightNo: j + 1, left: a[i]!, right: b[j]!, kind: 'same' });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      pendingRemoved.push({ no: i + 1, text: a[i]! });
      i += 1;
    } else {
      pendingAdded.push({ no: j + 1, text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    pendingRemoved.push({ no: i + 1, text: a[i]! });
    i += 1;
  }
  while (j < m) {
    pendingAdded.push({ no: j + 1, text: b[j]! });
    j += 1;
  }
  flush();

  return out;
}

/** 统计增删行数（页签上的 +N -M）。 */
export function diffStats(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'remove') removed += 1;
    else if (line.kind === 'change') {
      added += 1;
      removed += 1;
    }
  }
  return { added, removed };
}
