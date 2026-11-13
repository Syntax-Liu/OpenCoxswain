import path from 'node:path';
import { MemoryStore } from '@opencoxswain/memory';
import type { PluginContext } from '@opencoxswain/plugin-api';

/**
 * 记忆库插件：SQLite + FTS5 为事实来源，Markdown 快照导出到 memoryDir。
 * 写入事件进入总线，便于回放与观测。
 */
export async function apply(ctx: PluginContext): Promise<void> {
  const config = ctx.config;
  const store = new MemoryStore({
    dbPath: path.join(config.memoryDir, 'memory.db'),
    memoryDir: config.memoryDir,
    notify: (type, payload) => ctx.emit(type, payload),
  });
  ctx.effect(() => store.close());
  ctx.provide('memory', store);
  ctx.log(`记忆库已就绪：${config.memoryDir}`);
}
