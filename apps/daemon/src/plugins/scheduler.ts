import type { PluginContext } from '@opencoxswain/plugin-api';
import { Scheduler } from '../scheduler.js';

export function apply(ctx: PluginContext): void {
  const scheduler = new Scheduler({
    store: ctx.service('storage'),
    bus: ctx.service('events'),
    config: ctx.service('config'),
    runtimes: ctx.service('runtimes'),
    worktrees: ctx.service('worktrees'),
    employees: ctx.service('employees'),
    verification: ctx.service('verification'),
    supervisor: ctx.service('supervisor'),
  });

  ctx.provide('scheduler', scheduler);
  ctx.on('kernel.ready', () => scheduler.start());
  ctx.effect(() => scheduler.stop());
}
