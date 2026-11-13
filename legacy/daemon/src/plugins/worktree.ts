import { mkdir } from 'node:fs/promises';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { WorktreeManager } from '../worktree.js';

export async function apply(ctx: PluginContext): Promise<void> {
  const config = ctx.service('config');
  await mkdir(config.worktreesDir, { recursive: true });
  ctx.provide('worktrees', new WorktreeManager(config.worktreesDir));
}
