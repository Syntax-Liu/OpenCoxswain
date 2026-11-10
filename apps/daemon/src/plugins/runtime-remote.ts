import type { PluginContext } from '@opencoxswain/plugin-api';
import { RemoteRuntimeAdapter } from '../remote-runtime.js';

export function apply(ctx: PluginContext): void {
  const config = ctx.service('config');
  const registry = ctx.service('runtimes');
  const remote = ctx.service('remote');
  const adapter = new RemoteRuntimeAdapter({
    remote,
    runtimes: registry,
    fallbackRuntime: config.remoteFallbackRuntime,
    jobTimeoutMs: config.remoteJobTimeoutMs,
    claimTimeoutMs: config.remoteClaimTimeoutMs,
  });
  ctx.effect(registry.register(adapter));
}
