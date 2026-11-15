/**
 * 模型配置：多模型 + 按角色绑定 + 每模型参数。
 *
 * ## 为什么要有这一层
 *
 * 一个模型不够用：Supervisor 要判断力强（想得久一点没关系），
 * Agent 要便宜且快（要跑几十轮）。同一个模型配置也会因为
 * 上下文长度、是否支持图片而不同。
 *
 * ## 结构
 *
 * ```
 * models:  [{ id, name, baseUrl, apiKey(密文), model, params }]
 * roles:   { supervisor: modelId, assistant: modelId, agent: modelId }
 * ```
 *
 * 参数放在**每个模型**上而不是全局：不同厂商支持的参数不同，
 * 全局参数会出现"给 A 模型设了 thinking，B 模型不认"的矛盾。
 */

/** 一个可选的模型配置。 */
export interface ModelConfig {
  readonly id: string;
  /** 显示名，例如「DeepSeek Chat」。 */
  readonly name: string;
  /** OpenAI 兼容端点。 */
  readonly baseUrl: string;
  /** 密钥（存储时为密文，读取时解密）。 */
  readonly apiKey: string;
  /** 传给 API 的 model 字段。 */
  readonly model: string;
  readonly params: ModelParams;
}

/**
 * 模型参数。
 *
 * **全部可选**：不同厂商支持的不一样，没设就不传，
 * 让服务端用自己的默认值，不要替他做决定。
 */
export interface ModelParams {
  /** 思考强度（DeepSeek / OpenAI 的 reasoning effort）。 */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  /** 上下文长度上限（token）。不设则用服务端默认。 */
  readonly contextLength?: number;
  /** 是否支持图片输入（决定界面是否允许贴图）。 */
  readonly supportsImages?: boolean;
  /**
   * 工具调用最多几轮。
   *
   * 防止模型陷入"调工具 → 看结果 → 再调"的死循环。
   * 这也是用量止损之外的一道保险。
   */
  readonly maxToolRounds?: number;
  /** 采样温度。 */
  readonly temperature?: number;
  /** 核采样。 */
  readonly topP?: number;
}

/** 三角色分别用哪个模型（存 id）。 */
export interface RoleBindings {
  readonly supervisor: string | null;
  readonly assistant: string | null;
  readonly agent: string | null;
}

export interface ModelSettings {
  readonly models: readonly ModelConfig[];
  readonly roles: RoleBindings;
}

export const DEFAULT_PARAMS: ModelParams = {};

export const EMPTY_MODEL_SETTINGS: ModelSettings = {
  models: [],
  roles: { supervisor: null, assistant: null, agent: null },
};

/** 参数范围校验（防止用户填出会被服务端拒掉的值）。 */
export const PARAM_LIMITS = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  contextLength: { min: 1024, max: 2_000_000 },
  maxToolRounds: { min: 1, max: 200 },
} as const;

/** 某个角色最终该用哪个模型。 */
export function modelForRole(
  settings: ModelSettings,
  role: keyof RoleBindings,
): ModelConfig | null {
  const id = settings.roles[role];
  if (id) {
    const bound = settings.models.find((m) => m.id === id);
    if (bound) return bound;
  }

  // **没绑定 → 回退到默认模型**。
  //
  // 界面里那行文案写的是「不绑定的角色会用『沿用当前密钥』那套默认配置」，
  // 但这里原来直接 `return null` —— 文案承诺的回退**根本没实现**。
  //
  // 后果不是"用错模型"，而是**参数全丢**：
  // `paramsOf()` 拿到 null，`supportsImages` 一律按 false 处理，
  // 用户在设置里勾了"支持图片输入"、图片也确实发到了服务端，
  // 但请求体里没有 image 块 —— 模型自然说"我看不到图"。
  //
  // 回退规则（保守，不猜）：
  //   1. 只有**一个**模型 → 就是它（用户没得选，默认即唯一）
  //   2. 有多个 → 不猜，返回 null（让它走"沿用当前密钥"那条老路径）
  //
  // 为什么不总是回退到第一个：有多个模型时猜错会让用户
  // 以为"我明明绑了 A 却用了 B"，比不生效更难查。
  if (settings.models.length === 1) {
    return settings.models[0] ?? null;
  }
  return null;
}

/**
 * 校验参数，返回**人话错误**（用于界面提示）。
 *
 * 非法值不静默丢弃——用户填错了要明确告诉他哪里不对。
 */
export function validateParams(params: ModelParams): string[] {
  const errors: string[] = [];

  if (params.temperature !== undefined) {
    const { min, max } = PARAM_LIMITS.temperature;
    if (!(params.temperature >= min && params.temperature <= max)) {
      errors.push(`Temperature 应在 ${min}–${max} 之间`);
    }
  }

  if (params.topP !== undefined) {
    const { min, max } = PARAM_LIMITS.topP;
    if (!(params.topP >= min && params.topP <= max)) {
      errors.push(`Top P 应在 ${min}–${max} 之间`);
    }
  }

  if (params.contextLength !== undefined) {
    const { min, max } = PARAM_LIMITS.contextLength;
    if (!Number.isInteger(params.contextLength) || params.contextLength < min) {
      errors.push(`上下文长度至少 ${min}`);
    } else if (params.contextLength > max) {
      errors.push(`上下文长度不能超过 ${max}`);
    }
  }

  if (params.maxToolRounds !== undefined) {
    const { min, max } = PARAM_LIMITS.maxToolRounds;
    if (!Number.isInteger(params.maxToolRounds) || params.maxToolRounds < min) {
      errors.push(`工具调用轮数至少 ${min}`);
    } else if (params.maxToolRounds > max) {
      errors.push(`工具调用轮数不能超过 ${max}`);
    }
  }

  return errors;
}

/** 校验整个配置：id 唯一、绑定指向存在的模型。 */
export function validateSettings(settings: ModelSettings): string[] {
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const model of settings.models) {
    if (!model.id) errors.push('模型缺少 id');
    if (ids.has(model.id)) errors.push(`模型 id 重复：${model.id}`);
    ids.add(model.id);
    if (!model.baseUrl.trim()) errors.push(`模型「${model.name}」缺少端点`);
    if (!model.model.trim()) errors.push(`模型「${model.name}」缺少模型名`);
    errors.push(...validateParams(model.params).map((e) => `模型「${model.name}」：${e}`));
  }

  for (const [role, id] of Object.entries(settings.roles)) {
    if (id !== null && !ids.has(id)) {
      errors.push(`角色 ${role} 指向了不存在的模型 ${id}`);
    }
  }

  return errors;
}

/** 把参数转成 API 请求里的字段（只带有值的）。 */
export function toRequestOptions(params: ModelParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.temperature !== undefined) out.temperature = params.temperature;
  if (params.topP !== undefined) out.top_p = params.topP;
  if (params.reasoningEffort !== undefined) out.reasoning_effort = params.reasoningEffort;
  if (params.contextLength !== undefined) out.max_tokens = params.contextLength;
  return out;
}
