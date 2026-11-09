import type { PluginContext } from '@opencoxswain/plugin-api';
import { inspectSupervision } from '@opencoxswain/core';

/** 规则版监察插件：只做规则判断，不调用 LLM，也不改提示词。 */
export function apply(ctx: PluginContext): void {
  ctx.requirePermission('supervisor:provide');
  ctx.provide('supervisor', {
    inspect: inspectSupervision,
  });
}
