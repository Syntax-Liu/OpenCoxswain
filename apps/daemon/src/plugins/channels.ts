import path from 'node:path';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { Channels } from '../channels.js';

export function apply(ctx: PluginContext): void {
  const channels = new Channels({
    store: ctx.service('storage'),
    bus: ctx.service('events'),
    steward: ctx.service('steward'),
    filePath: path.join(ctx.config.homeDir, 'channels.json'),
    log: (message, detail) => ctx.log(message, detail),
  });
  ctx.provide('channels', channels);

  ctx.on('runtime.reaped', (payload) => {
    const killed = (payload as { killed?: unknown } | null)?.killed;
    const list = Array.isArray(killed) ? killed.map((item) => String(item)) : [];
    if (list.length === 0) return;
    channels.notice({
      kind: 'orphan',
      dedupKey: 'runtime.reaped',
      text: `【遗留进程】已回收上次未正常退出的 OpenCode 进程：${list.join('、')}`,
    });
  });

  // 事件总线在 kernel.ready 后才稳定，且通道插件加载晚于运行时，延后订阅不会漏事件。
  ctx.on('kernel.ready', () => {
    ctx.effect(channels.start());
  });
}
