import type { RuntimeAdapter } from '@opencoxswain/adapters';
import type { RuntimeStatus } from '@opencoxswain/shared';
import type { PluginContext, RuntimeRegistry } from '@opencoxswain/plugin-api';

export function apply(ctx: PluginContext): void {
  const adapters = new Map<string, RuntimeAdapter>();

  const registry: RuntimeRegistry = {
    register(adapter) {
      if (adapters.has(adapter.name)) {
        throw new Error(`运行时 ${adapter.name} 已注册`);
      }
      adapters.set(adapter.name, adapter);
      return () => adapters.delete(adapter.name);
    },
    get(name) {
      return adapters.get(name);
    },
    list() {
      return [...adapters.values()];
    },
    async health(): Promise<RuntimeStatus> {
      const [adapter] = adapters.values();
      if (!adapter) {
        return { adapter: 'none', ok: false, detail: '没有注册任何运行时' };
      }
      const status = await adapter.healthCheck();
      return { adapter: adapter.name, ok: status.ok, detail: status.detail };
    },
  };

  ctx.provide('runtimes', registry);
}
