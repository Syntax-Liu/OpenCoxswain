/**
 * 方案把关 —— 是否强制"没批准不许派活"。
 *
 * ## 为什么做成可开关，且默认关闭
 *
 * 「方案给用户看完才开工」的硬关卡落点。
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
 * 默认值：**`off`**。
 *
 * ## 为什么退回 off
 *
 * 曾经为了"方案给用户看完才开工"（D1）把它改成 `on`。
 * 但用户随后明确了产品方向：
 *
 * > 「方案的呈现只需要像截图这样，提示创建或修改了哪个文件，
 * >  不需要做这么复杂的功能。我们想做的就是让用户和 AI 更轻松地对话，
 * >  而不是造一堆窗口。」
 *
 * 界面上已经没有"批准方案"的入口了。此时若还开着硬关卡，
 * 用户会看到一个"方案未批准"的拒绝，却找不到任何地方去批准——
 * **那比不做关卡更糟**。
 *
 * ## 保留它做什么
 *
 * 把关逻辑本身是好的，只是不该默认生效：
 * - 想严格管控的团队可以按项目打开（`projects: { prj_x: 'on' }`）
 * - 将来若真的做了轻量的"方案确认"交互，再考虑改默认
 *
 * 开启后语义不是"拦下所有活"（见 `orchestrator.spawn`）：
 * 没有活跃方案 → 放行；有方案但未批准 → 拒绝。
 */
export const DEFAULT_PLAN_GATE: PlanGateSettings = {
  mode: 'off',
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
