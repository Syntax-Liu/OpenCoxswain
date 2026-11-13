import type { Budget, CostLedger } from '@opencoxswain/shared';

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface BudgetEvaluation {
  status: BudgetStatus;
  ratio: number;
  reasons: string[];
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 单任务/日预算：70% 警告，100% 硬停。 */
export function evaluateBudget(budget: Budget, used: CostLedger): BudgetEvaluation {
  const ratios: number[] = [];
  const reasons: string[] = [];

  const checks: Array<{ label: string; limit?: number; used: number; format: (n: number) => string }> = [
    { label: 'tokens', limit: budget.tokens, used: used.tokensIn + used.tokensOut, format: (n) => `${Math.round(n)}` },
    { label: 'usd', limit: budget.usd, used: used.usd, format: formatUsd },
    { label: 'minutes', limit: budget.minutes, used: used.minutes, format: (n) => `${n.toFixed(1)} 分钟` },
  ];

  for (const check of checks) {
    if (check.limit === undefined) continue;
    const ratio = check.used / check.limit;
    ratios.push(ratio);
    if (ratio >= 1) {
      reasons.push(`${check.label} 已用 ${check.format(check.used)} / 上限 ${check.format(check.limit)}（硬停）`);
    } else if (ratio >= 0.7) {
      reasons.push(`${check.label} 已用 ${check.format(check.used)} / 上限 ${check.format(check.limit)}（${Math.round(ratio * 100)}%）`);
    }
  }

  const ratio = ratios.length === 0 ? 0 : Math.max(...ratios);
  const status: BudgetStatus = ratio >= 1 ? 'exceeded' : ratio >= 0.7 ? 'warning' : 'ok';
  return { status, ratio, reasons };
}

export function sumBudgets(budgets: Budget[]): Budget {
  const total: Budget = {};
  for (const budget of budgets) {
    if (budget.tokens !== undefined) total.tokens = (total.tokens ?? 0) + budget.tokens;
    if (budget.usd !== undefined) total.usd = (total.usd ?? 0) + budget.usd;
    if (budget.minutes !== undefined) total.minutes = (total.minutes ?? 0) + budget.minutes;
  }
  return total;
}

export function emptyCost(): CostLedger {
  return { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 };
}

export function addCost(a: CostLedger, b: CostLedger): CostLedger {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    usd: a.usd + b.usd,
    minutes: a.minutes + b.minutes,
  };
}
