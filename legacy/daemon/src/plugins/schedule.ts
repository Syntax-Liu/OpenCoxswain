import type { PluginContext } from '@opencoxswain/plugin-api';
import { Schedules } from '../schedule.js';

/** 到点检查间隔；错过的时段不补跑，只按当前时刻重新计时。 */
const TICK_MS = 15_000;

export function apply(ctx: PluginContext): void {
  const schedules = new Schedules({
    store: ctx.service('storage'),
    bus: ctx.service('events'),
    steward: ctx.service('steward'),
    log: (message, detail) => ctx.log(message, detail),
  });
  ctx.provide('schedules', schedules);

  ctx.on('kernel.ready', () => {
    const timer = setInterval(() => {
      void schedules.tick().catch((error) => ctx.log('定时任务检查失败', error));
    }, TICK_MS);
    timer.unref?.();
    ctx.effect(() => clearInterval(timer));
  });
}
