import { MockRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';

export function apply(ctx: PluginContext): void {
  const registry = ctx.service('runtimes');
  const adapter = new MockRuntimeAdapter();
  ctx.effect(registry.register(adapter));
}
