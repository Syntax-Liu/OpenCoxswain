/**
 * 上下文用量预警。
 *
 * ## 为什么需要
 *
 * 压缩发生时用户会突然觉得"它怎么忘了前面"。如果不提前提示，
 * 那就是一次**没有预告的信息丢失**——用户不知道发生了什么，
 * 也不知道该怎么避免。
 *
 * 现在做的：在接近上限时给一个明确的、可解释的提示。
 *
 * ## 三档
 *
 * | 档位 | 含义 | 界面表现 |
 * | --- | --- | --- |
 * | ok | 富余 | 正常显示用量 |
 * | near | 接近上限 | 琥珀色提示"上下文快满了" |
 * | compacted | 已经压缩过 | 明确说明压掉多少、怎么避免 |
 *
 * ## 一个刻意的取舍：不在 near 档自动行动
 *
 * 有些产品会在接近上限时**自动开始裁剪**。我们不这么做——
 * 那会让用户在某一步突然收不到完整信息，却不知道是自己触发的。
 *
 * 这里只提示，不动手。真正的压缩由 `compact.ts` 在超限时做，
 * 而且会在轨迹里留记录。
 */

/** 上下文用量档位。 */
export type ContextLevel = 'ok' | 'near' | 'compacted';

/** 接近上限的阈值（比例）。 */
export const NEAR_LIMIT_RATIO = 0.75;

/** 上下文窗口的估算上限。 */
export const CONTEXT_WINDOW = 96_000;

export interface ContextUsage {
  /** 当前估算的 token 数。 */
  readonly used: number;
  /** 上下文窗口上限。 */
  readonly limit: number;
  /** 使用比例 0..1。 */
  readonly ratio: number;
  readonly level: ContextLevel;
  /** 给用户看的一句话（ok 档为 null，不需要打扰）。 */
  readonly message: string | null;
}

/**
 * 计算上下文用量与提示。
 *
 * `compactionCount` 来自轨迹里压缩记录的条数——已经压缩过就升级到
 * compacted 档，因为那时用户最需要知道"前面为什么没了"。
 */
export function describeContext(
  used: number,
  options: {
    readonly limit?: number;
    readonly compactionCount?: number;
  } = {},
): ContextUsage {
  const limit = options.limit ?? CONTEXT_WINDOW;
  const safeUsed = Math.max(0, used);
  const ratio = limit > 0 ? Math.min(1, safeUsed / limit) : 0;
  const compactionCount = options.compactionCount ?? 0;

  if (compactionCount > 0) {
    return {
      used: safeUsed,
      limit,
      ratio,
      level: 'compacted',
      message:
        `上下文已压缩 ${compactionCount} 次——较早的内容被折叠了，所以它可能想不起很久之前说过的话。` +
        '想减少压缩：把长任务拆成几个短会话，或用 @ 精确引用文件而不是让它自己搜。',
    };
  }

  if (ratio >= NEAR_LIMIT_RATIO) {
    return {
      used: safeUsed,
      limit,
      ratio,
      level: 'near',
      message:
        `上下文已用 ${Math.round(ratio * 100)}%，接近上限。` +
        '再过一会儿较早的内容会被自动折叠——想保住某段信息，考虑开始一个新会话。',
    };
  }

  return { used: safeUsed, limit, ratio, level: 'ok', message: null };
}

/** 把 token 数格式化成好读的形式。 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

/** 进度条宽度（字符数），给状态栏用小图形表示。 */
export function progressBar(ratio: number, width = 8): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
