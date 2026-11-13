import { loadConfig, type DaemonConfig } from './config.js';
import { Kernel } from './kernel/kernel.js';
import { discoverExternalManifests, mergeManifests } from './kernel/loader.js';
import { builtinManifests } from './plugins/manifests.js';

export interface DaemonApp {
  config: DaemonConfig;
  port: number;
  close: () => Promise<void>;
}

export async function startDaemon(overrides: Partial<DaemonConfig> = {}): Promise<DaemonApp> {
  const config = loadConfig(overrides);
  const kernel = new Kernel(config);

  try {
    const external = await discoverExternalManifests(config.pluginsDir);
    await kernel.load(mergeManifests(builtinManifests(), external));
    await kernel.start();
  } catch (error) {
    await kernel.stop();
    throw error;
  }

  const port = kernel.service('http').port();
  return {
    config: { ...config, port },
    port,
    close: () => kernel.stop(),
  };
}
