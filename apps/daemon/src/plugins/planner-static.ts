import type { PluginContext } from '@opencoxswain/plugin-api';
import { Planner } from '../planner.js';

export function apply(ctx: PluginContext): void {
  ctx.provide('planner', new Planner());
}
