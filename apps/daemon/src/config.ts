import os from 'node:os';
import path from 'node:path';
import type { OpenCoxswainConfig } from '@opencoxswain/plugin-api';

export const APP_VERSION = '0.29.0';

export type DaemonConfig = OpenCoxswainConfig;

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
    version: APP_VERSION,
    host: overrides.host ?? process.env.OPENCOXSWAIN_HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 47821,
    homeDir,
    dbPath: overrides.dbPath ?? path.join(homeDir, 'opencoxswain.db'),
    worktreesDir: overrides.worktreesDir ?? path.join(homeDir, 'worktrees'),
    artifactsDir: overrides.artifactsDir ?? path.join(homeDir, 'artifacts'),
    memoryDir: overrides.memoryDir ?? path.join(homeDir, 'memory'),
    pluginsDir:
      overrides.pluginsDir ??
      process.env.OPENCOXSWAIN_PLUGINS ??
      path.join(homeDir, 'plugins'),
    maxConcurrency:
      Number.isFinite(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 2,
    defaultRuntime:
      (overrides.defaultRuntime ?? process.env.OPENCOXSWAIN_DEFAULT_RUNTIME ?? 'mock').trim() ||
      'mock',
    defaultModel: (overrides.defaultModel ?? process.env.OPENCOXSWAIN_DEFAULT_MODEL ?? '').trim(),
    opencodeBin: (overrides.opencodeBin ?? process.env.OPENCOXSWAIN_OPENCODE_BIN ?? '').trim(),
    commandTimeoutMs: overrides.commandTimeoutMs ?? 5 * 60 * 1000,
    supervisionIntervalMs:
      overrides.supervisionIntervalMs ??
      Number(process.env.OPENCOXSWAIN_SUPERVISION_MS ?? 30_000),
    leaseTtlMs:
      overrides.leaseTtlMs ?? Number(process.env.OPENCOXSWAIN_LEASE_MS ?? 30_000),
    remoteClaimTimeoutMs:
      overrides.remoteClaimTimeoutMs ??
      Number(process.env.OPENCOXSWAIN_REMOTE_CLAIM_MS ?? 45_000),
    remoteJobTimeoutMs:
      overrides.remoteJobTimeoutMs ??
      Number(process.env.OPENCOXSWAIN_REMOTE_JOB_MS ?? 30 * 60_000),
    remoteFallbackRuntime:
      (overrides.remoteFallbackRuntime ?? process.env.OPENCOXSWAIN_REMOTE_FALLBACK ?? '').trim(),
  };
}
