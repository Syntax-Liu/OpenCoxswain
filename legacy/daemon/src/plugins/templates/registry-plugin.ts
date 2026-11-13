import type { PluginContext } from '@opencoxswain/plugin-api';
import { BUILTIN_TEMPLATES } from './builtin.js';
import { InMemoryTemplateRegistry } from './registry.js';

export function apply(ctx: PluginContext): void {
  const registry = new InMemoryTemplateRegistry();
  for (const template of BUILTIN_TEMPLATES) {
    registry.register(template, ctx.id);
  }
  ctx.provide('templates', registry);
}
