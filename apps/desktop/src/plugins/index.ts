import type { UiRegistry } from './registry.js';
import { conversationPlugin } from './conversation.js';
import { guidePlugin } from './guide.js';
import { inboxPlugin } from './inbox.js';
import { inspectorTabPlugins } from './inspector.js';
import { projectsPlugin } from './projects.js';
import { taskTreePlugin } from './task-tree.js';
import { workerBoardPlugin } from './worker-board.js';

export function registerBuiltinUiPlugins(registry: UiRegistry): void {
  for (const plugin of [
    guidePlugin,
    projectsPlugin,
    inboxPlugin,
    taskTreePlugin,
    conversationPlugin,
    workerBoardPlugin,
    ...inspectorTabPlugins,
  ]) {
    registry.register(plugin);
  }
}
