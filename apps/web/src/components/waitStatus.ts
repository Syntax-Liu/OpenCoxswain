/**
 * 等待状态。
 *
 * ## 为什么需要
 *
 * 现在 Assistant 思考时界面上只有三个跳动的点。用户不知道它是：
 * - 在推理（正常，等着就行）
 * - 在等模型响应（网络慢，可能要等）
 * - 已经卡住了（该考虑按停止）
 *
 * 延迟消不掉，但**可以变得可理解**。这是交互调研里的 P0。
 *
 * ## 设计：说出在等什么 + 等了多久
 *
 * 不给转圈，给**具体的名词和秒数**：
 *
 * ```
 * 正在等模型响应 · 12 秒
 * 已派出 3 个 Agent，最快的一个已跑 40 秒
 * 较慢，可以继续等或按停止 · 45 秒
 * ```
 *
 * ## 三档阈值
 *
 * | 阶段 | 时长 | 文案 |
 * | --- | --- | --- |
 * | 正常 | < 15s | 正在等模型响应 · N 秒 |
 * | 偏慢 | 15–45s | 稍慢，还在等 · N 秒 |
 * | 很慢 | ≥ 45s | 较慢，可以继续等或按停止 · N 秒 |
 *
 * 阈值不设成固定的精确值——所以用区间判断而不是精确匹配。
 */

/** 等待阶段的档位。 */
export type WaitLevel = 'normal' | 'slow' | 'stalled';

/** 偏慢的阈值（毫秒）。 */
export const SLOW_MS = 15_000;

/** 很慢的阈值（毫秒）。 */
export const STALLED_MS = 45_000;

export interface WaitStatus {
  readonly level: WaitLevel;
  /** 已经等了多久（毫秒）。 */
  readonly elapsedMs: number;
  /** 给用户看的一句话。 */
  readonly text: string;
}

/** 把毫秒格式化成"12 秒" / "1 分 20 秒"。 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

/** 判断档位。 */
export function waitLevel(elapsedMs: number): WaitLevel {
  if (elapsedMs >= STALLED_MS) return 'stalled';
  if (elapsedMs >= SLOW_MS) return 'slow';
  return 'normal';
}

/**
 * 生成等待状态的描述。
 *
 * `runningAgents` 给的是当前在跑的 Agent 数量——有 Agent 在跑时，
 * 等的其实是 Agent 而不是模型，文案要说对。
 */
export function describeWait(
  elapsedMs: number,
  options: { readonly runningAgents?: number } = {},
): WaitStatus {
  const level = waitLevel(elapsedMs);
  const running = options.runningAgents ?? 0;
  const time = formatElapsed(elapsedMs);

  // 有 Agent 在跑：等的是它们干活，不是等模型说话
  if (running > 0) {
    const agents = `${running} 个 Agent`;
    if (level === 'stalled') {
      return {
        level,
        elapsedMs,
        text: `${agents}在跑，已经 ${time}——可以继续等，也可以按停止`,
      };
    }
    return { level, elapsedMs, text: `${agents}在跑 · ${time}` };
  }

  if (level === 'stalled') {
    return {
      level,
      elapsedMs,
      text: `较慢，可以继续等或按停止 · ${time}`,
    };
  }
  if (level === 'slow') {
    return { level, elapsedMs, text: `稍慢，还在等 · ${time}` };
  }
  return { level, elapsedMs, text: `正在等模型响应 · ${time}` };
}

/**
 * 估算 Agent 还要多久——用于在"很久没动静"时给个判断依据。
 *
 * **不做精确预测**。只是把已完成 Agent 的中位耗时拿出来做参照，
 * 让人知道"通常需要多久"，而不是"还有多少秒"。
 *
 * 少于 2 个样本时返回 null——一个样本不构成规律。
 */
export function estimateTypicalDuration(completedMs: readonly number[]): number | null {
  const valid = completedMs.filter((n) => n > 0).sort((a, b) => a - b);
  if (valid.length < 2) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 === 0
    ? Math.round((valid[mid - 1]! + valid[mid]!) / 2)
    : valid[mid]!;
}
