/**
 * 用量止损线（**不是计费**）。
 *
 * 为什么不估算金额：不同模型单价不同且随时调整，软件离线无法获取实时价格，
 * 用户本来就能在服务商后台看到真实账单。估算出来的金额只会误导人。
 *
 * 那为什么还保留一个上限？因为 token 是**真实的、模型自己报告的数字**，
 * 用它做止损不需要任何假设：
 *
 * - 一个失控的执行者（例如反复重试、死循环）可能在几分钟内烧掉大量额度；
 * - 用户需要能设一条线，超了就停，而不是等账单出来才发现。
 *
 * 所以这里叫 `tokenGuard`（用量保护），不叫 budget（预算）。
 */

export interface CostLedger {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/** 阈值：达到即触发。 */
export interface TokenGuard {
  /** 单个执行者上限。 */
  readonly perTask?: number;
  /** 项目每日上限。 */
  readonly perDay?: number;
}

export type GuardStatus = 'ok' | 'warning' | 'exceeded';

export interface GuardEvaluation {
  readonly status: GuardStatus;
  readonly ratio: number;
  readonly reasons: readonly string[];
  /** 触发硬停的那一项的可读描述。 */
  readonly breached?: string;
}

export function totalTokens(cost: CostLedger): number {
  return cost.tokensIn + cost.tokensOut;
}

export function emptyCost(): CostLedger {
  return { tokensIn: 0, tokensOut: 0 };
}

export function addCost(a: CostLedger, b: CostLedger): CostLedger {
  return { tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function check(
  label: string,
  used: number,
  limit: number | undefined,
): { ratio: number; reason?: string; breached: boolean } | null {
  if (limit === undefined || limit <= 0) return null;
  const ratio = used / limit;
  if (ratio >= 1) {
    return {
      ratio,
      breached: true,
      reason: `${label}已用 ${formatTokens(used)} / 上限 ${formatTokens(limit)}`,
    };
  }
  if (ratio >= 0.8) {
    return {
      ratio,
      breached: false,
      reason: `${label}已用 ${formatTokens(used)} / 上限 ${formatTokens(limit)}（${Math.round(ratio * 100)}%）`,
    };
  }
  return { ratio, breached: false };
}

/**
 * 派活前检查：只看项目当日总量。
 *
 * 单个执行者此时还没开始跑，不可能超。
 */
export function evaluateSpawn(guard: TokenGuard, todayCost: CostLedger): GuardEvaluation {
  const result = check('今日 token ', totalTokens(todayCost), guard.perDay);
  if (!result) return { status: 'ok', ratio: 0, reasons: [] };
  return {
    status: result.breached ? 'exceeded' : result.ratio >= 0.8 ? 'warning' : 'ok',
    ratio: result.ratio,
    reasons: result.reason ? [result.reason] : [],
    ...(result.breached && result.reason ? { breached: result.reason } : {}),
  };
}

/** 运行中检查：本任务用量 + 项目当日用量。 */
export function evaluateRunning(
  guard: TokenGuard,
  taskCost: CostLedger,
  todayCost: CostLedger,
): GuardEvaluation {
  const checks = [
    check('本任务 token ', totalTokens(taskCost), guard.perTask),
    check('今日 token ', totalTokens(todayCost), guard.perDay),
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  if (checks.length === 0) return { status: 'ok', ratio: 0, reasons: [] };

  const breached = checks.find((c) => c.breached);
  const ratio = Math.max(...checks.map((c) => c.ratio));
  const reasons = checks.map((c) => c.reason).filter((r): r is string => !!r);

  return {
    status: breached ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'ok',
    ratio,
    reasons,
    ...(breached?.reason ? { breached: breached.reason } : {}),
  };
}

/** 解析用量保护配置。非法值直接拒绝，不静默忽略。 */
export function parseTokenGuard(raw: unknown): TokenGuard {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const out: { perTask?: number; perDay?: number } = {};

  for (const key of ['perTask', 'perDay'] as const) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`用量上限 ${key} 必须是非负数字，收到：${String(value)}`);
    }
    if (num > 0) out[key] = num;
  }
  return out;
}

/** 当日边界（本地时区）。 */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
