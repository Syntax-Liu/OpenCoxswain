import type { PluginContext } from '@opencoxswain/plugin-api';
import { Steward } from '../steward.js';

export function apply(ctx: PluginContext): void {
  const steward = new Steward({
    store: ctx.service('storage'),
    bus: ctx.service('events'),
    planner: ctx.service('planner'),
    runtimes: ctx.service('runtimes'),
    scheduler: ctx.service('scheduler'),
    employees: ctx.service('employees'),
    memory: ctx.service('memory'),
    worktrees: ctx.service('worktrees'),
  });

  ctx.provide('steward', steward);
  ctx.on('root.settled', (payload) => {
    const rootId = (payload as { rootId?: unknown }).rootId;
    if (typeof rootId === 'string') steward.onRootSettled(rootId);
  });
}
