import os from 'node:os';
import path from 'node:path';

export const APP_VERSION = '0.1.0';

export interface DaemonConfig {
  host: string;
  port: number;
  homeDir: string;
  dbPath: string;
  worktreesDir: string;
  artifactsDir: string;
  maxConcurrency: number;
}

function defaultHome(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return path.join(localAppData, 'OpenCoxswain');
  return path.join(os.homedir(), '.opencoxswain');
}

export function loadConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const homeDir =
    overrides.homeDir ?? process.env.OPENCOXSWAIN_HOME ?? defaultHome();
  const port = overrides.port ?? Number(process.env.OPENCOXSWAIN_PORT ?? 47821);
  const maxConcurrency =
    overrides.maxConcurrency ?? Number(process.env.OPENCOXSWAIN_CONCURRENCY ?? 2);

  return {
    host: overrides.host ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 47821,
    homeDir,
    dbPath: overrides.dbPath ?? path.join(homeDir, 'opencoxswain.db'),
    worktreesDir: overrides.worktreesDir ?? path.join(homeDir, 'worktrees'),
    artifactsDir: overrides.artifactsDir ?? path.join(homeDir, 'artifacts'),
    maxConcurrency:
      Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 2,
  };
}
