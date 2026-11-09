import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_API_VERSION,
  type Permission,
  type PluginManifest,
  type ServiceKey,
} from '@opencoxswain/plugin-api';

const SERVICE_KEYS: ServiceKey[] = [
  'config',
  'events',
  'storage',
  'worktrees',
  'runtimes',
  'employees',
  'verification',
  'planner',
  'scheduler',
  'steward',
  'secrets',
  'http',
];

const PERMISSIONS: Permission[] = [
  'events:publish',
  'events:read',
  'storage:read',
  'storage:write',
  'storage:provide',
  'fs:data',
  'fs:worktree',
  'process:spawn',
  'runtime:use',
  'runtime:provide',
  'planner:use',
  'scheduler:control',
  'steward:call',
  'secrets:read',
  'secrets:write',
  'secrets:provide',
  'http:route',
  'net:listen',
  'employee:use',
  'employee:provide',
  'verification:run',
  'verification:provide',
  'ui:panel',
];

const KINDS = new Set([
  'runtime',
  'planner',
  'scheduler',
  'steward',
  'storage',
  'transport',
  'api',
  'ui',
  'worktree',
  'employee',
  'other',
]);

function fail(source: string, message: string): never {
  throw new Error(`插件清单 ${source} 无效：${message}`);
}

function stringArray(value: unknown, source: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(source, `${field} 必须是字符串数组`);
  }
  return value as string[];
}

export function parseManifest(value: unknown, source: string, baseDir?: string): PluginManifest {
  if (typeof value !== 'object' || value === null) fail(source, '根节点必须是对象');
  const raw = value as Record<string, unknown>;
  if (raw.apiVersion !== PLUGIN_API_VERSION) {
    fail(source, `apiVersion 必须为 ${PLUGIN_API_VERSION}`);
  }
  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    fail(source, 'id 必须是小写标识符');
  }
  const name = raw.name;
  const version = raw.version;
  const entry = raw.entry;
  if (typeof name !== 'string' || name.trim() === '') fail(source, 'name 不能为空');
  if (typeof version !== 'string' || version.trim() === '') fail(source, 'version 不能为空');
  if (typeof entry !== 'string' || entry.trim() === '') fail(source, 'entry 不能为空');
  const kind = raw.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) fail(source, `未知 kind：${String(kind)}`);

  const provides = stringArray(raw.provides ?? [], source, 'provides');
  const inject = stringArray(raw.inject ?? [], source, 'inject');
  const permissions = stringArray(raw.permissions ?? [], source, 'permissions');
  for (const key of [...provides, ...inject]) {
    if (!SERVICE_KEYS.includes(key as ServiceKey)) fail(source, `未知服务 ${key}`);
  }
  for (const permission of permissions) {
    if (!PERMISSIONS.includes(permission as Permission)) fail(source, `未知权限 ${permission}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    fail(source, 'enabled 必须是布尔值');
  }

  const resolved =
    entry.startsWith('file:') || path.isAbsolute(entry)
      ? entry.startsWith('file:')
        ? entry
        : pathToFileURL(entry).href
      : baseDir
        ? pathToFileURL(path.resolve(baseDir, entry)).href
        : fail(source, '相对 entry 必须提供 baseDir');

  return {
    apiVersion: PLUGIN_API_VERSION,
    id,
    name,
    version,
    kind: kind as PluginManifest['kind'],
    entry: resolved,
    provides: provides as ServiceKey[],
    inject: inject as ServiceKey[],
    permissions: permissions as Permission[],
    enabled: raw.enabled as boolean | undefined,
    config: raw.config,
  };
}

export function orderManifests(manifests: PluginManifest[]): PluginManifest[] {
  const enabled = manifests.filter((manifest) => manifest.enabled !== false);
  const providers = new Map<ServiceKey, string>([
    ['config', 'kernel'],
    ['events', 'kernel'],
  ]);
  for (const manifest of enabled) {
    for (const key of manifest.provides) {
      const existing = providers.get(key);
      if (existing) {
        throw new Error(`服务 ${key} 被 ${existing} 与 ${manifest.id} 同时声明`);
      }
      providers.set(key, manifest.id);
    }
  }
  for (const manifest of enabled) {
    for (const key of manifest.inject) {
      if (!providers.has(key)) {
        throw new Error(`插件 ${manifest.id} 依赖的服务 ${key} 没有提供者`);
      }
    }
  }

  const byId = new Map(enabled.map((manifest) => [manifest.id, manifest]));
  const indegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  for (const manifest of enabled) {
    indegree.set(manifest.id, 0);
    edges.set(manifest.id, new Set());
  }
  for (const manifest of enabled) {
    for (const key of manifest.inject) {
      const provider = providers.get(key);
      if (!provider || provider === 'kernel' || provider === manifest.id) continue;
      if (!byId.has(provider)) continue;
      const set = edges.get(provider);
      if (!set) continue;
      if (!set.has(manifest.id)) {
        set.add(manifest.id);
        indegree.set(manifest.id, (indegree.get(manifest.id) ?? 0) + 1);
      }
    }
  }

  const queue = enabled.filter((manifest) => (indegree.get(manifest.id) ?? 0) === 0);
  const ordered: PluginManifest[] = [];
  while (queue.length > 0) {
    const manifest = queue.shift();
    if (!manifest) break;
    ordered.push(manifest);
    for (const next of edges.get(manifest.id) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, value);
      if (value === 0) {
        const found = byId.get(next);
        if (found) queue.push(found);
      }
    }
  }
  if (ordered.length !== enabled.length) {
    const cycle = enabled
      .filter((manifest) => !ordered.includes(manifest))
      .map((manifest) => manifest.id);
    throw new Error(`插件依赖存在循环：${cycle.join('、')}`);
  }
  return ordered;
}

export function mergeManifests(
  builtin: PluginManifest[],
  external: PluginManifest[],
): PluginManifest[] {
  const merged = new Map(builtin.map((manifest) => [manifest.id, manifest]));
  for (const manifest of external) merged.set(manifest.id, manifest);
  return [...merged.values()];
}

export async function discoverExternalManifests(dir: string): Promise<PluginManifest[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const manifests: PluginManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'plugin.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      fail(manifestPath, '不是合法 JSON');
    }
    manifests.push(parseManifest(value, manifestPath, pluginDir));
  }
  return manifests;
}
