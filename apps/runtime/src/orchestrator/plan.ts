/**
 * 方案（Plan）——跨轮次活着的施工依据。
 *
 * ## 为什么需要它
 *
 * 没有方案时：Assistant 不知道自己还剩哪几步，断电重开接不上，
 * 用户也看不出"它是做完了还是忘了"。
 *
 * 方案提供三样东西：
 *   1. **进度载体**：哪步做完了、哪步在做、哪步卡住
 *   2. **唯一的人为关卡**：`awaiting-approval`，批过一次就一路做到底
 *   3. **改动记录**：小改动要提示不中断，大改动要停工重批
 *
 * ## 设计依据
 *
 * 本模块只放**状态机与判定规则**，
 * 不碰存储、不碰 IO——那些在 store 与 orchestrator 里。
 *
 * ## 一条硬约束
 *
 * `approved` 之外的状态，一律不许派方案内的步骤（见 `canSpawnStep`）。
 * 这是"方案给用户看完才开工"在代码里的唯一落点；没有它，审批就是摆设。
 */

/** 步骤状态。 */
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

/** 方案状态。 */
export type PlanStatus =
  | 'draft'
  | 'awaiting-approval'
  | 'approved'
  | 'superseded'
  | 'done'
  | 'blocked';

/** 改动的性质。**由"是否触碰验收标准"决定，不允许 Assistant 自己说不大**。 */
export type AmendmentKind = 'small' | 'big';

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  /** 给 Agent 的完整目标（它看不到 Assistant 与用户的对话）。 */
  readonly goal: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly unknown[];
  readonly acceptancePolicy: 'auto' | 'unverified_only' | 'always_human';
  readonly status: StepStatus;
  /**
   * 重试计数。
   *
   * **跟着步骤走，不跟着 Agent 走**——重派会换新 Agent，
   * 若计数挂在 Agent 上，重试就永远数不到，会无限循环。
   */
  readonly attempts: number;
  readonly dependsOn?: readonly string[];
}

export interface Amendment {
  readonly id: string;
  readonly kind: AmendmentKind;
  /** 涉及哪几个步骤。 */
  readonly where: readonly string[];
  readonly what: string;
  readonly why: string;
  /**
   * **大改动的机器判据**：是否修改或新增了验收标准。
   *
   * 只要这里为 true，`kind` 必须是 `big`——由 `normalizeAmendment` 强制，
   * 不接受 Assistant 自称"这个改动不大"。
   */
  readonly criteriaTouched: boolean;
  readonly decidedAt: number;
}

export interface Plan {
  readonly id: string;
  readonly projectId: string;
  /** 用户最初那句话。 */
  readonly goal: string;
  readonly steps: readonly PlanStep[];
  readonly status: PlanStatus;
  readonly approvedAt: number | null;
  readonly approvedBy: 'user' | null;
  readonly amendments: readonly Amendment[];
  readonly createdAt: number;
}

// ─────────────────────────────────────────────
// 状态机
// ─────────────────────────────────────────────

/** 允许的状态迁移。不在表里的迁移一律拒绝。 */
const TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ['awaiting-approval'],
  'awaiting-approval': ['approved', 'draft'], // 批准 或 驳回后改
  approved: ['done', 'superseded', 'blocked'],
  // 作废后必须重新走审批——不允许从 superseded 直接回 approved
  superseded: ['awaiting-approval'],
  // 卡住经人处理后回到执行态，但不回到 awaiting-approval（方案没变）
  blocked: ['approved'],
  done: [],
};

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 迁到新状态。不允许的迁移直接抛错——**静默允许比报错危险得多**。
 */
export function transition(plan: Plan, to: PlanStatus, now = Date.now()): Plan {
  if (!canTransition(plan.status, to)) {
    throw new Error(`方案状态不允许从 ${plan.status} 迁到 ${to}`);
  }
  return {
    ...plan,
    status: to,
    ...(to === 'approved' ? { approvedAt: now, approvedBy: 'user' as const } : {}),
  };
}

/**
 * **硬约束**：能不能派方案内的步骤。
 *
 * 只有 `approved` 能派。其余一律不行——这是"批一次就够"的前提。
 */
export function canSpawnStep(plan: Plan): { allowed: boolean; reason?: string } {
  if (plan.status === 'approved') return { allowed: true };
  const msg: Record<PlanStatus, string> = {
    draft: '方案还在起草，没有交给你看',
    'awaiting-approval': '方案还没批准——批过之后才会开工',
    superseded: '方案已被大改动作废，需要你重新批准',
    blocked: '方案卡住了，等人处理后才继续',
    done: '方案已经全部完成',
    approved: '',
  };
  return { allowed: false, reason: msg[plan.status] };
}

// ─────────────────────────────────────────────
// 大改动 / 小改动判定
// ─────────────────────────────────────────────

/**
 * 规范化一条改动记录。
 *
 * **`criteriaTouched === true` 时强制 `kind === 'big'`**。
 * 这是整套设计里唯一需要精确判定的地方：结果有没有变，
 * 而不是动作大不大。不允许 Assistant 绕过去。
 */
export function normalizeAmendment(
  input: Omit<Amendment, 'id' | 'decidedAt'> & { readonly id?: string; readonly decidedAt?: number },
  now = Date.now(),
): Amendment {
  const kind: AmendmentKind = input.criteriaTouched ? 'big' : input.kind;
  return {
    id: input.id ?? `amd_${now}_${Math.random().toString(36).slice(2, 8)}`,
    kind,
    where: input.where,
    what: input.what,
    why: input.why,
    criteriaTouched: input.criteriaTouched,
    decidedAt: input.decidedAt ?? now,
  };
}

/**
 * 应用一条改动。
 *
 * - 小改动：记进 amendments，**流程不中断**
 * - 大改动：记进 amendments，方案变 `superseded`，需要重批
 */
export function applyAmendment(plan: Plan, amendment: Amendment): Plan {
  const amendments = [...plan.amendments, amendment];
  if (amendment.kind === 'small') {
    return { ...plan, amendments };
  }
  // 大改动：作废，等重批
  return { ...plan, amendments, status: 'superseded' };
}

// ─────────────────────────────────────────────
// 步骤推进与失败重试
// ─────────────────────────────────────────────

/** 重试上限：前两次不打扰用户，第 3 次卡住。 */
export const MAX_ATTEMPTS = 2;

export interface StepOutcome {
  readonly plan: Plan;
  /** 是否要交给用户（第 3 次失败）。 */
  readonly escalate: boolean;
  /** 下一步该做的步骤 id（自动推进用）。 */
  readonly nextStepId: string | null;
}

/**
 * 某步失败后的处理。
 *
 * - attempts < MAX_ATTEMPTS：**自动重派**（不打扰用户），计数 +1
 * - attempts >= MAX_ATTEMPTS：该步 blocked，方案 blocked，交给人
 */
export function onStepFailed(plan: Plan, stepId: string): StepOutcome {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`方案里没有步骤 ${stepId}`);

  const attempts = step.attempts + 1;
  const escalate = attempts > MAX_ATTEMPTS;

  const steps = plan.steps.map((s) =>
    s.id === stepId
      ? { ...s, attempts, status: escalate ? ('blocked' as const) : ('pending' as const) }
      : s,
  );

  return {
    plan: {
      ...plan,
      steps,
      status: escalate ? 'blocked' : plan.status,
    },
    escalate,
    nextStepId: escalate ? null : stepId,
  };
}

/** 某步成功后的处理：标记完成，返回下一个可做的步骤。 */
export function onStepDone(plan: Plan, stepId: string): StepOutcome {
  const steps = plan.steps.map((s) => (s.id === stepId ? { ...s, status: 'done' as const } : s));
  const next = nextRunnableStep(steps);
  const allDone = steps.every((s) => s.status === 'done');

  return {
    plan: {
      ...plan,
      steps,
      status: allDone ? 'done' : plan.status,
    },
    escalate: false,
    nextStepId: next?.id ?? null,
  };
}

/**
 * 下一个可做的步骤：`pending` 且依赖都已完成。
 *
 * 依赖不满足的步骤**跳过**，不会因为顺序问题卡住整条链。
 */
export function nextRunnableStep(steps: readonly PlanStep[]): PlanStep | null {
  const done = new Set(steps.filter((s) => s.status === 'done').map((s) => s.id));
  return (
    steps.find(
      (s) => s.status === 'pending' && (s.dependsOn ?? []).every((d) => done.has(d)),
    ) ?? null
  );
}

// ─────────────────────────────────────────────
// 构造与诊断
// ─────────────────────────────────────────────

export function createPlan(input: {
  readonly id: string;
  readonly projectId: string;
  readonly goal: string;
  readonly steps: readonly Omit<PlanStep, 'status' | 'attempts'>[];
  readonly now?: number;
}): Plan {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    projectId: input.projectId,
    goal: input.goal,
    steps: input.steps.map((s) => ({ ...s, status: 'pending' as const, attempts: 0 })),
    status: 'draft',
    approvedAt: null,
    approvedBy: null,
    amendments: [],
    createdAt: now,
  };
}

/** 给界面用的进度摘要。 */
export interface PlanProgress {
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly blocked: number;
  readonly running: number;
}

export function progressOf(plan: Plan): PlanProgress {
  const count = (s: StepStatus): number => plan.steps.filter((x) => x.status === s).length;
  return {
    total: plan.steps.length,
    done: count('done'),
    failed: count('failed'),
    blocked: count('blocked'),
    running: count('running'),
  };
}

/** 一句话描述当前状态，给界面横条用。 */
export function describePlanStatus(plan: Plan): string {
  const p = progressOf(plan);
  switch (plan.status) {
    case 'draft':
      return '正在起草方案';
    case 'awaiting-approval':
      return `方案待批准（${p.total} 步）`;
    case 'approved':
      return `执行中：${p.done}/${p.total} 步完成`;
    case 'superseded':
      return '方案有大改动，等重新批准';
    case 'blocked':
      return `卡在第 ${p.blocked} 步，等你处理`;
    case 'done':
      return `全部完成（${p.total} 步）`;
    default:
      return '';
  }
}
