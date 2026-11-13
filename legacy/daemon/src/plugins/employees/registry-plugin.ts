import type { PluginContext } from '@opencoxswain/plugin-api';
import { InMemoryEmployeeRegistry } from './registry.js';

export function apply(ctx: PluginContext): void {
  ctx.provide('employees', new InMemoryEmployeeRegistry());
}
