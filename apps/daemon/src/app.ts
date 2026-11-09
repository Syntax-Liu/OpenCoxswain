import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { MockRuntimeAdapter, type RuntimeAdapter } from '@opencoxswain/adapters';
import { EventBus } from './bus.js';
import { loadConfig, type DaemonConfig } from './config.js';
import { Planner } from './planner.js';
import { Scheduler } from './scheduler.js';
import { createApiServer } from './server.js';
import { Steward } from './steward.js';
import { Store } from './store.js';
import { WorktreeManager } from './worktree.js';

export interface DaemonApp {
  config: DaemonConfig;
  port: number;
  store: Store;
  bus: EventBus;
  scheduler: Scheduler;
  steward: Steward;
  server: Server;
  close: () => Promise<void>;
}

export async function startDaemon(overrides: Partial<DaemonConfig> = {}): Promise<DaemonApp> {
  const config = loadConfig(overrides);
  await mkdir(config.homeDir, { recursive: true });
  await mkdir(config.worktreesDir, { recursive: true });
  await mkdir(config.artifactsDir, { recursive: true });

  const store = new Store(config.dbPath);
  const bus = new EventBus();
  const mock = new MockRuntimeAdapter();
  const adapters = new Map<string, RuntimeAdapter>([['mock', mock]]);
  const worktrees = new WorktreeManager(config.worktreesDir);

  const scheduler = new Scheduler({ store, bus, config, adapters, worktrees });
  const steward = new Steward({
    store,
    bus,
    planner: new Planner(),
    runtimeHealth: async () => {
      const status = await mock.healthCheck();
      return { adapter: 'mock', ok: status.ok, detail: status.detail };
    },
  });
  steward.setControl({
    cancel: (taskId) => scheduler.cancel(taskId),
    pause: (taskId) => scheduler.pause(taskId),
    resume: (taskId) => scheduler.resume(taskId),
  });
  scheduler.setHooks({ onRootSettled: (rootId) => steward.onRootSettled(rootId) });
  scheduler.start();

  const server = createApiServer({
    store,
    bus,
    steward,
    config,
    health: () => mock.healthCheck(),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : config.port;

  return {
    config: { ...config, port },
    port,
    store,
    bus,
    scheduler,
    steward,
    server,
    close: async () => {
      await scheduler.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
