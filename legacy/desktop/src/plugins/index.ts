import type { UiRegistry } from './registry.js';
import { conversationPlugin } from './conversation.js';
import { inboxPlugin } from './inbox.js';
import { inspectorTabPlugins } from './inspector.js';
import { projectsPlugin } from './projects.js';
import { schedulePlugin } from './schedule.js';
import { taskTreePlugin } from './task-tree.js';
import { workerBoardPlugin } from './worker-board.js';

export function registerBuiltinUiPlugins(registry: UiRegistry): void {
  for (const plugin of [
    projectsPlugin,
    inboxPlugin,
    taskTreePlugin,
    conversationPlugin,
    workerBoardPlugin,
    schedulePlugin,
    ...inspectorTabPlugins,
  ]) {
    registry.register(plugin);
  }
}
