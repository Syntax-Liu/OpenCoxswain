import { BuiltinRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';
import {
  currentBaseUrl,
  currentModel,
  DEFAULT_BASE_URL,
  SETTING_BASE_URL,
  SETTING_PROVIDER,
} from './llm-target.js';

/**
 * 内置执行体插件：把模型工具循环直接跑在 daemon 里，不依赖任何外部 CLI。
 * 凭据与模型每次派发时从设置/凭据库读取，用户在设置页修改后立即生效。
 */
export async function apply(ctx: PluginContext): Promise<void> {
  const registry = ctx.service('runtimes');
  const secrets = ctx.service('secrets');
  const storage = ctx.service('storage');

  const adapter = new BuiltinRuntimeAdapter({
    commandTimeoutMs: ctx.config.commandTimeoutMs,
    resolve: async () => {
      const apiKey = (await secrets.get('llm_api_key')) ?? '';
      if (!apiKey) return null;
      const baseUrl = currentBaseUrl(storage, process.env.OPENCOXSWAIN_LLM_BASE_URL) || DEFAULT_BASE_URL;
      const provider = storage.getSetting(SETTING_PROVIDER) ?? '';
      return {
        apiKey,
        baseUrl,
        model: currentModel(storage, ctx.config.defaultModel),
        provider,
      };
    },
  });

  ctx.effect(registry.register(adapter));
  ctx.effect(() => adapter.disposeAll());
  ctx.on('kernel.ready', () => {
    const baseUrl = storage.getSetting(SETTING_BASE_URL) ?? DEFAULT_BASE_URL;
    ctx.log(`内置执行体已就绪（${currentModel(storage, ctx.config.defaultModel)} @ ${baseUrl}）`);
  });
}
