import { OpenCodeRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';

export function apply(ctx: PluginContext): void {
  const registry = ctx.service('runtimes');
  const adapter = new OpenCodeRuntimeAdapter({ binPath: ctx.config.opencodeBin });
  ctx.effect(registry.register(adapter));
  // 内核停止时先收回活跃会话，避免退出后 OpenCode 进程树继续占着 worktree。
  ctx.effect(() => adapter.disposeAll());
}
