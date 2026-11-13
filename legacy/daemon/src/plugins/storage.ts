import { mkdirSync } from 'node:fs';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { Store } from '../store.js';

export function apply(ctx: PluginContext): void {
  const config = ctx.service('config');
  mkdirSync(config.homeDir, { recursive: true });
  const store = new Store(config.dbPath);
  ctx.effect(() => store.close());
  ctx.provide('storage', store);
}
