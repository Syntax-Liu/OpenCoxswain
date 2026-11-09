import type { UiRegistry } from './registry.js';
import { conversationPlugin } from './conversation.js';
import { inspectorTabPlugins } from './inspector.js';
import { taskTreePlugin } from './task-tree.js';
import { workerBoardPlugin } from './worker-board.js';

export function registerBuiltinUiPlugins(registry: UiRegistry): void {
  for (const plugin of [
    taskTreePlugin,
    conversationPlugin,
    workerBoardPlugin,
    ...inspectorTabPlugins,
  ]) {
    registry.register(plugin);
  }
}
