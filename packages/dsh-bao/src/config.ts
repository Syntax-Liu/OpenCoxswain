/**
 * 插件配置（四层结构）。
 *
 * 全部字段都可缺省，缺省后插件以"可观测但不动手"的方式工作：
 * 工具会明确告诉调用方缺什么，而不是假装成功。
 */

export interface BaoConfig {
  /** 子代理后端名，默认 `spawn`（唯一支持 agentPreset 的后端）。 */
  readonly provider?: string;
  /** C（项目助理）的 preset id，默认 `project-assistant`。 */
  readonly assistantPreset?: string;
  /** D（执行者）的 preset id，默认 `task-executor`。 */
  readonly executorPreset?: string;
  /**
   * C 同时可跑多少个 D。方案 §7.2 D2：**默认 5**，可调且不超过
   * dsh 的 `maxActiveSubagents`（默认 8）。
   */
  readonly maxConcurrentExecutors?: number;
  /** 单条汇报正文上限，超出截断并标注，避免 domain 记录无限膨胀。 */
  readonly maxReportChars?: number;
  /**
   * 汇报去抖窗口（毫秒）。方案 §7 D4：谁先完成先报谁，但同一批
   * 同时完成的多个 D 合并成一条。默认 800ms。
   */
  readonly reportDebounceMs?: number;
  /** 一个任务最多换几个 D 重试（P4 主动推进）。默认 1。 */
  readonly maxAutoRetries?: number;
}

export const DEFAULT_PROVIDER = 'spawn';
export const DEFAULT_ASSISTANT_PRESET = 'project-assistant';
export const DEFAULT_EXECUTOR_PRESET = 'task-executor';
export const DEFAULT_MAX_CONCURRENT_EXECUTORS = 5;
/** dsh 侧 `maxActiveSubagents` 的默认值，用于给出"会不会硬失败"的可读提示。 */
export const DSH_DEFAULT_MAX_ACTIVE_SUBAGENTS = 8;
export const DEFAULT_MAX_REPORT_CHARS = 8000;
export const DEFAULT_REPORT_DEBOUNCE_MS = 800;
export const DEFAULT_MAX_AUTO_RETRIES = 1;

export interface ResolvedConfig {
  readonly provider: string;
  readonly assistantPreset: string;
  readonly executorPreset: string;
  readonly maxConcurrentExecutors: number;
  readonly maxReportChars: number;
  readonly reportDebounceMs: number;
  readonly maxAutoRetries: number;
}

/** 配置里的告警（不阻断，但必须让用户看见）。 */
export interface ConfigWarning {
  readonly code: string;
  readonly message: string;
}

export interface ResolveConfigResult {
  readonly config: ResolvedConfig;
  readonly warnings: readonly ConfigWarning[];
}

export function resolveConfig(
  raw: BaoConfig | undefined,
  options: { readonly hostMaxActiveSubagents?: number } = {},
): ResolveConfigResult {
  const maxConcurrentExecutors = raw?.maxConcurrentExecutors ?? DEFAULT_MAX_CONCURRENT_EXECUTORS;
  if (!Number.isSafeInteger(maxConcurrentExecutors) || maxConcurrentExecutors < 1) {
    throw new RangeError(
      `maxConcurrentExecutors 必须是正整数，收到：${String(maxConcurrentExecutors)}`,
    );
  }

  const maxReportChars = raw?.maxReportChars ?? DEFAULT_MAX_REPORT_CHARS;
  if (!Number.isSafeInteger(maxReportChars) || maxReportChars < 200) {
    throw new RangeError(`maxReportChars 至少 200，收到：${String(maxReportChars)}`);
  }

  const reportDebounceMs = raw?.reportDebounceMs ?? DEFAULT_REPORT_DEBOUNCE_MS;
  if (!Number.isSafeInteger(reportDebounceMs) || reportDebounceMs < 0) {
    throw new RangeError(`reportDebounceMs 不能为负，收到：${String(reportDebounceMs)}`);
  }

  const maxAutoRetries = raw?.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES;
  if (!Number.isSafeInteger(maxAutoRetries) || maxAutoRetries < 0) {
    throw new RangeError(`maxAutoRetries 不能为负，收到：${String(maxAutoRetries)}`);
  }

  const warnings: ConfigWarning[] = [];

  // 方案 §7.2 / L5：dsh 的配额超限是**直接拒绝**，不是排队。
  // 我们在插件侧自建闸门，但上限若超过 dsh 配额，第 N 个 D 会硬失败。
  const hostLimit = options.hostMaxActiveSubagents ?? DSH_DEFAULT_MAX_ACTIVE_SUBAGENTS;
  if (maxConcurrentExecutors > hostLimit) {
    warnings.push({
      code: 'EXCEEDS_HOST_SUBAGENT_LIMIT',
      message:
        `maxConcurrentExecutors=${maxConcurrentExecutors} 超过了 dsh 的 maxActiveSubagents=` +
        `${hostLimit}，第 ${hostLimit + 1} 个执行者会直接失败（dsh 不做排队）。` +
        `请把上限调到 ${hostLimit} 或更小。`,
    });
  }

  return {
    config: {
      provider: raw?.provider?.trim() || DEFAULT_PROVIDER,
      assistantPreset: raw?.assistantPreset?.trim() || DEFAULT_ASSISTANT_PRESET,
      executorPreset: raw?.executorPreset?.trim() || DEFAULT_EXECUTOR_PRESET,
      maxConcurrentExecutors,
      maxReportChars,
      reportDebounceMs,
      maxAutoRetries,
    },
    warnings,
  };
}
