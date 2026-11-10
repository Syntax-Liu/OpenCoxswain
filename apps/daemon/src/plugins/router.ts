import type { PluginContext } from '@opencoxswain/plugin-api';
import { GoalRouter } from '../router.js';

export function apply(ctx: PluginContext): void {
  ctx.provide(
    'router',
    new GoalRouter({
      store: ctx.service('storage'),
      memory: ctx.service('memory'),
      log: (message, detail) => ctx.log(message, detail),
    }),
  );
}
