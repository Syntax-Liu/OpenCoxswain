/**
 * 方案把关 —— 是否强制"没批准不许派活"。
 *
 * ## 为什么做成可开关，且默认关闭
 *
 * `plan-approval.md` 的 D1 要求"方案给用户看完才开工"，硬关卡是它的落点。
 * 但**目前还没有"创建方案"的流程**（Assistant 还不会出方案）。
 *
 * 如果此刻就强制拦截，所有派活都会失败，产品直接停摆。
 *
 * 所以分两步走：
 *   1. **现在**：把关逻辑接进去，但默认 `off`——行为与之前完全一致
 *   2. **方案创建流程做完后**：把默认改成 `on`，硬关卡才真正生效
 *
 * 用户可以让 Assistant 自己判断什么时候出方案：
 *   - 用户明确要求出方案 → 一定出
 *   - 用户没要求，但任务复杂、不能一步到位 → Assistant 自己决定出
 *   这条判断在提示词里（见 assistant/prompt.ts），不在本文件。
 *
 * ## 两个档位
 *
 * | 值 | 行为 |
 * | --- | --- |
 * | `off` | 不检查方案状态，派活照旧（**默认**） |
 * | `on` | 没批准就不许派方案内的步骤 |
 *
 * 与 `settings/permission.ts` 的权限档位**分开放**：
 * 那是"要不要问你某个动作"，这是"要不要先批方案"。两件事。
 */

export const PLAN_GATE_MODES = ['off', 'on'] as const;
export type PlanGateMode = (typeof PLAN_GATE_MODES)[number];

export const PLAN_GATE_LABEL: Record<PlanGateMode, string> = {
  off: '不拦（直接派活）',
  on: '先批方案再开工',
};

export interface PlanGateSettings {
  readonly mode: PlanGateMode;
  /**
   * 每个项目的覆盖。
   *
   * 与权限档位一致：某些项目想严一些，某些想松一些。
   */
  readonly projects?: Readonly<Record<string, PlanGateMode>>;
}

/**
 * 默认值：**`on`**。
 *
 * 2026-11-15 之前这里是 `off`，因为那时还没有"创建方案"的流程，
 * 强制拦截会让所有派活失败。现在方案创建（`propose_plan`）、
 * 批准（`/api/plans/:id/approve`）、界面审阅都已就位，可以开启了。
 *
 * 注意 `on` 的实际语义（见 `orchestrator.spawn`）：
 * - **没有活跃方案** → 放行（不是所有活都必须先有计划）
 * - 有活跃方案但未批准 → 拒绝
 * 所以开启它不会把日常小事也拦下来。
 */
export const DEFAULT_PLAN_GATE: PlanGateSettings = {
  mode: 'on',
};

/** 解析未知输入，坏数据一律退回默认（不能因为配置坏了就不许派活）。 */
export function parsePlanGate(input: unknown): PlanGateSettings {
  if (!input || typeof input !== 'object') return DEFAULT_PLAN_GATE;
  const raw = input as { mode?: unknown; projects?: unknown };

  const mode: PlanGateMode = PLAN_GATE_MODES.includes(raw.mode as PlanGateMode)
    ? (raw.mode as PlanGateMode)
    : DEFAULT_PLAN_GATE.mode;

  let projects: Record<string, PlanGateMode> | undefined;
  if (raw.projects && typeof raw.projects === 'object') {
    projects = {};
    for (const [k, v] of Object.entries(raw.projects as Record<string, unknown>)) {
      if (PLAN_GATE_MODES.includes(v as PlanGateMode)) {
        projects[k] = v as PlanGateMode;
      }
    }
    if (Object.keys(projects).length === 0) projects = undefined;
  }

  return { mode, ...(projects ? { projects } : {}) };
}

/** 读某个项目实际生效的档位。 */
export function planGateFor(settings: PlanGateSettings, projectId: string): PlanGateMode {
  return settings.projects?.[projectId] ?? settings.mode;
}

/** 是否开启硬关卡。 */
export function planGateEnabled(settings: PlanGateSettings, projectId: string): boolean {
  return planGateFor(settings, projectId) === 'on';
}
