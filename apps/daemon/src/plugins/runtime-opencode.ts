import path from 'node:path';
import { OpenCodeRuntimeAdapter } from '@opencoxswain/adapters';
import type { PluginContext } from '@opencoxswain/plugin-api';

export async function apply(ctx: PluginContext): Promise<void> {
  const registry = ctx.service('runtimes');
  const adapter = new OpenCodeRuntimeAdapter({
    binPath: ctx.config.opencodeBin,
    ledgerDir: path.join(ctx.config.homeDir, 'pids'),
  });
  // daemon 被任务管理器强杀时来不及卸载，启动时按 PID 台账回收遗留的 OpenCode 进程树。
  const reaped = await adapter.reapOrphans();
  if (reaped.killed.length > 0) {
    ctx.log(`已回收上次遗留的 OpenCode 进程：${reaped.killed.join(', ')}`);
    // 通道插件加载晚于运行时；等内核就绪再广播，避免通知被错过。
    ctx.on('kernel.ready', () => ctx.emit('runtime.reaped', reaped));
  }
  ctx.effect(registry.register(adapter));
  // 内核停止时先收回活跃会话，避免退出后 OpenCode 进程树继续占着 worktree。
  ctx.effect(() => adapter.disposeAll());
}
