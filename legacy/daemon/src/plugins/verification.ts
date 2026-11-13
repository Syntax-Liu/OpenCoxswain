import type { PluginContext } from '@opencoxswain/plugin-api';
import { SystemVerification } from '../verification.js';

export function apply(ctx: PluginContext): void {
  ctx.provide(
    'verification',
    new SystemVerification({ timeoutMs: ctx.config.commandTimeoutMs }),
  );
}
