import { OpenCodeRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';

export function apply(ctx: PluginContext): void {
  const registry = ctx.service('runtimes');
  const adapter = new OpenCodeRuntimeAdapter({ binPath: ctx.config.opencodeBin });
  ctx.effect(registry.register(adapter));
}
