import path from 'node:path';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { DpapiVault } from '../secrets.js';

export function apply(ctx: PluginContext): void {
  const vault = new DpapiVault(path.join(ctx.config.homeDir, 'secrets'));
  ctx.provide('secrets', vault);
  if (vault.backend !== 'dpapi') {
    ctx.log('当前平台没有 DPAPI，密钥仓库不可用，仅回退环境变量');
  }
}
