import type {
  EventRecord,
  SupervisionVerdict,
  Task,
  Worker,
} from '@opencoxswain/shared';

export interface SupervisionThresholds {
  /** 无任何事件超过该时长 → nudge。 */
  noHeartbeatMs: number;
  /** 连续多少个 tool_call 没有产物/进度 → nudge。 */
  stallToolCalls: number;
  /** 相同工具+入参连续出现多少次 → nudge。 */
  repeatedFingerprint: number;
  /** 单 run 超过预算分钟数的比例 → warn。 */
  longTailRatio: number;
  /** 已用预算比例 → warn。 */
  budgetRatio: number;
}

export const DEFAULT_SUPERVISION_THRESHOLDS: SupervisionThresholds = {
  noHeartbeatMs: 5 * 60_000,
  stallToolCalls: 8,
  repeatedFingerprint: 3,
  longTailRatio: 0.8,
  budgetRatio: 0.8,
};

export interface SupervisionInput {
  task: Task;
  worker: Worker;
  /** 按时间升序。 */
  recentEvents: EventRecord[];
  now: number;
  startedAt: number;
}

function payloadOf(event: EventRecord): Record<string, unknown> | null {
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

function withinScope(scope: string[], target: string): boolean {
  if (scope.length === 0) return true;
  const normalized = target.replace(/\\/g, '/');
  return scope.some((entry) => {
    const prefix = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function fingerprint(event: EventRecord): string | null {
  if (event.type !== 'runtime.tool_call') return null;
  const payload = payloadOf(event);
  if (!payload) return null;
  return `${String(payload.tool)}:${JSON.stringify(payload.input ?? null)}`;
}

function offScope(input: SupervisionInput): string | null {
  const scope = input.task.contract.write_scope ?? [];
  for (const event of input.recentEvents) {
    if (event.type !== 'runtime.tool_call') continue;
    const payload = payloadOf(event);
    const target = payload?.input;
    if (typeof target !== 'object' || target === null) continue;
    const record = target as Record<string, unknown>;
    if (record.path === undefined) continue;
    if (payload?.tool !== 'file_write' && payload?.tool !== 'write') continue;
    if (!withinScope(scope, String(record.path))) {
      return `变更路径 ${String(record.path)} 不在 write_scope（${scope.join('、') || '空'}）内`;
    }
  }
  return null;
}

function emptyCompletion(input: SupervisionInput): string | null {
  const writeScope = input.task.contract.write_scope ?? [];
  if (writeScope.length === 0) return null;
  for (const event of input.recentEvents) {
    if (event.type !== 'runtime.finished') continue;
    const result = payloadOf(event)?.result as { artifacts?: unknown[] } | undefined;
    if (Array.isArray(result?.artifacts) && result.artifacts.length === 0) {
      return '员工报告完成但没有任何产物，判定为空转完成';
    }
  }
  return null;
}

function repeated(input: SupervisionInput, threshold: number): string | null {
  let last: string | null = null;
  let count = 0;
  for (const event of input.recentEvents) {
    const current = fingerprint(event);
    if (current === null) continue;
    if (current === last) {
      count += 1;
    } else {
      last = current;
      count = 1;
    }
    if (count >= threshold) return `连续 ${count} 次相同工具调用：${last}`;
  }
  return null;
}

function stalled(input: SupervisionInput, threshold: number): string | null {
  let count = 0;
  for (let index = input.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = input.recentEvents[index]!;
    if (event.type === 'runtime.tool_call') {
      count += 1;
      if (count >= threshold) return `连续 ${count} 次工具调用没有新增产物或进度`;
      continue;
    }
    if (event.type === 'runtime.artifact' || event.type === 'runtime.progress') return null;
  }
  return null;
}

/**
 * 规则监察：纯计算、可单测，不调用 LLM。
 * 优先级：越权变更 > 空转完成 > 无心跳 > 重复调用 > 停滞 > 预算/长尾。
 */
export function inspectSupervision(
  input: SupervisionInput,
  thresholds: SupervisionThresholds = DEFAULT_SUPERVISION_THRESHOLDS,
): SupervisionVerdict {
  const escape = offScope(input);
  if (escape) return { kind: 'pause', rule: 'off_scope', reason: escape };

  const empty = emptyCompletion(input);
  if (empty) return { kind: 'fail', rule: 'empty_completion', reason: empty };

  const lastActivity = input.recentEvents.at(-1)?.createdAt ?? input.startedAt;
  if (input.now - lastActivity > thresholds.noHeartbeatMs) {
    return {
      kind: 'nudge',
      rule: 'no_heartbeat',
      reason: `超过 ${Math.round(thresholds.noHeartbeatMs / 60_000)} 分钟没有任何事件`,
      message: '请汇报当前进展；如果卡住，说明卡点并尝试换一种方法。',
    };
  }

  const repeat = repeated(input, thresholds.repeatedFingerprint);
  if (repeat) {
    return {
      kind: 'nudge',
      rule: 'repeated_fingerprint',
      reason: repeat,
      message: '检测到同一动作连续重复，请换一种方法，或说明为什么必须重复。',
    };
  }

  const stall = stalled(input, thresholds.stallToolCalls);
  if (stall) {
    return {
      kind: 'nudge',
      rule: 'stalled',
      reason: stall,
      message: '已经多次调用工具但没有产出，请先汇报当前结论与下一步。',
    };
  }

  const budget = input.task.contract.budget;
  if (budget.usd && budget.usd > 0 && input.worker.cost.usd >= budget.usd * thresholds.budgetRatio) {
    return {
      kind: 'nudge',
      rule: 'budget_slope',
      reason: `已用 $${input.worker.cost.usd.toFixed(2)} / 预算 $${budget.usd.toFixed(2)}`,
      message: '预算即将用尽，请收口当前工作并优先交付核心结果。',
    };
  }

  const elapsedMinutes = (input.now - input.startedAt) / 60_000;
  if (
    budget.minutes &&
    budget.minutes > 0 &&
    elapsedMinutes > budget.minutes * thresholds.longTailRatio
  ) {
    return {
      kind: 'nudge',
      rule: 'long_tail',
      reason: `本次运行已 ${elapsedMinutes.toFixed(1)} 分钟，预算 ${budget.minutes} 分钟`,
      message: '运行时间接近预算，请尽快给出可验收的结果。',
    };
  }

  return { kind: 'ok' };
}
