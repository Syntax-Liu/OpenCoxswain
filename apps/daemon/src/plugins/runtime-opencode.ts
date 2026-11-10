import path from 'node:path';
import { OpenCodeRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';
import {
  currentBaseUrl,
  currentModel,
  OPENCODE_KEY_ENV,
  opencodeConfig,
} from './llm-target.js';

export async function apply(ctx: PluginContext): Promise<void> {
  const registry = ctx.service('runtimes');
  const secrets = ctx.service('secrets');
  const storage = ctx.service('storage');
  const adapter = new OpenCodeRuntimeAdapter({
    binPath: ctx.config.opencodeBin,
    ledgerDir: path.join(ctx.config.homeDir, 'pids'),
    // 每会话按当前设置生成 provider 配置与密钥，用户在设置页改完无需重启就能生效。
    setup: async () => {
      const key = await secrets.get('llm_api_key');
      if (!key) return {};
      const model = currentModel(storage, ctx.config.defaultModel);
      const baseUrl = currentBaseUrl(storage, process.env.OPENCOXSWAIN_LLM_BASE_URL);
      return {
        env: { [OPENCODE_KEY_ENV]: key },
        config: opencodeConfig(baseUrl, model),
      };
    },
  });
  // daemon 被任务管理器强杀时来不及卸载，启动时按 PID 台账回收遗留的 OpenCode 进程树。
  const reaped = await adapter.reapOrphans();
  if (reaped.killed.length > 0) {
    ctx.log(`已回收上次遗留的 OpenCode 进程：${reaped.killed.join(', ')}`);
    // 通道插件加载晚于运行时；等内核就绪再广播，避免通知被错过。
    ctx.on('kernel.ready', () => ctx.emit('runtime.reaped', reaped));
  }
  ctx.effect(registry.register(adapter));
  // 内核停止时先收回活跃会话，避免退出后 OpenCode 进程树继续占着 worktree。
  ctx.effect(() => adapter.disposeAll());
}
