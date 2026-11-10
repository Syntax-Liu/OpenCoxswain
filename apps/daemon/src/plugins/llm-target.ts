import type { StorageService } from '@opencoxswain/plugin-api';

export const SETTING_PROVIDER = 'llm.provider';
export const SETTING_BASE_URL = 'llm.baseUrl';
export const SETTING_MODEL = 'llm.model';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-v4-flash';

/** 官方给出的旧模型名映射：deepseek-chat → 非思考模式，deepseek-reasoner → 思考模式。 */
const LEGACY_DEEPSEEK_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

/** OpenCode 里给自定义 OpenAI 兼容端点用的 provider id 与密钥变量名。 */
export const OPENCODE_PROVIDER_ID = 'llm';
export const OPENCODE_KEY_ENV = 'OPENCOXSWAIN_LLM_KEY';
/** 没有 API Key 时退回 OpenCode 自带模型，任务依然会真实改代码。 */
export const OPENCODE_FREE_MODEL = 'opencode/deepseek-v4.1-flash-free';

/** 把已保存的模型名换成现行名称；旧配置也能直接跑。 */
export function resolveModel(stored: string): string {
  const name = stored.trim();
  return LEGACY_DEEPSEEK_MODELS[name] ?? name;
}

/** 当前生效的模型设置：设置表 → 环境变量 → 内置默认值。 */
export function currentModel(
  settings: Pick<StorageService, 'getSetting'>,
  envModel?: string,
): string {
  const stored = settings.getSetting(SETTING_MODEL) ?? envModel ?? DEFAULT_MODEL;
  return resolveModel(stored) || DEFAULT_MODEL;
}

/** 当前生效的 API 地址。 */
export function currentBaseUrl(
  settings: Pick<StorageService, 'getSetting'>,
  envBaseUrl?: string,
): string {
  const stored = (settings.getSetting(SETTING_BASE_URL) ?? envBaseUrl ?? DEFAULT_BASE_URL).trim();
  return (stored || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * 每会话写入隔离 XDG 目录的 OpenCode 配置：声明一个指向用户 API 地址的
 * OpenAI 兼容 provider，密钥由环境变量注入，模型名与 OpenCoxswain 设置保持一致。
 */
export function opencodeConfig(baseUrl: string, model: string): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    providers: {
      [OPENCODE_PROVIDER_ID]: {
        name: 'OpenCoxswain LLM',
        env: [OPENCODE_KEY_ENV],
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: baseUrl },
        models: { [model]: { name: model } },
      },
    },
  };
}
