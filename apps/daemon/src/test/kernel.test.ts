import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpenCoxswainConfig, PluginManifest } from '@opencoxswain/plugin-api';
import { builtinManifests } from '../plugins/manifests.js';
import { Kernel } from '../kernel/kernel.js';
import {
  mergeManifests,
  orderManifests,
  parseManifest,
} from '../kernel/loader.js';

function manifest(patch: Partial<PluginManifest> & Pick<PluginManifest, 'id'>): PluginManifest {
  return {
    apiVersion: 1,
    name: patch.id,
    version: '0.0.0',
    kind: 'other',
    entry: 'file:///none.js',
    provides: [],
    inject: [],
    permissions: [],
    ...patch,
  };
}

function configFor(homeDir: string): OpenCoxswainConfig {
  return {
    version: 'test',
    host: '127.0.0.1',
    port: 0,
    homeDir,
    dbPath: path.join(homeDir, 'test.db'),
    worktreesDir: path.join(homeDir, 'worktrees'),
    artifactsDir: path.join(homeDir, 'artifacts'),
    pluginsDir: path.join(homeDir, 'plugins'),
    maxConcurrency: 1,
    defaultRuntime: 'mock',
    defaultModel: '',
    opencodeBin: '',
    commandTimeoutMs: 120000,
  };
}

test('清单校验：apiVersion、kind、未知服务与权限', () => {
  assert.throws(() => parseManifest({ apiVersion: 2 }, 'x'), /apiVersion/);
  assert.throws(
    () =>
      parseManifest(
        { apiVersion: 1, id: 'a', name: 'A', version: '1.0.0', kind: 'nope', entry: 'a.js' },
        'x',
        '/tmp',
      ),
    /未知 kind/,
  );
  assert.throws(
    () =>
      parseManifest(
        {
          apiVersion: 1,
          id: 'a',
          name: 'A',
          version: '1.0.0',
          kind: 'other',
          entry: 'a.js',
          inject: ['secret'],
        },
        'x',
        '/tmp',
      ),
    /未知服务/,
  );
  const parsed = parseManifest(
    {
      apiVersion: 1,
      id: 'demo.plugin',
      name: 'Demo',
      version: '1.0.0',
      kind: 'other',
      entry: './entry.js',
      permissions: ['storage:read'],
    },
    'x',
    '/tmp/plugins/demo',
  );
  assert.equal(parsed.entry, pathToFileURL('/tmp/plugins/demo/entry.js').href);
});

test('拓扑排序：提供者先于消费者；缺依赖、重复服务、循环都会报错', () => {
  const provider = manifest({ id: 'p', provides: ['storage'] });
  const consumer = manifest({ id: 'c', inject: ['storage'] });
  const ordered = orderManifests([consumer, provider]);
  assert.deepEqual(ordered.map((item) => item.id), ['p', 'c']);

  assert.throws(() => orderManifests([consumer]), /没有提供者/);
  assert.throws(
    () =>
      orderManifests([
        provider,
        manifest({ id: 'p2', provides: ['storage'] }),
      ]),
    /同时声明/,
  );
  assert.throws(
    () =>
      orderManifests([
        manifest({ id: 'a', provides: ['storage'], inject: ['planner'] }),
        manifest({ id: 'b', provides: ['planner'], inject: ['storage'] }),
      ]),
    /循环/,
  );
});

test('清单合并：同 id 外部覆盖内置，enabled=false 不加载', () => {
  const builtin = manifest({ id: 'storage.sqlite', provides: ['storage'] });
  const external = manifest({ id: 'storage.sqlite', provides: ['storage'], version: '9.9.9' });
  const merged = mergeManifests([builtin], [external]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.version, '9.9.9');

  const disabled = mergeManifests([builtin], [manifest({ id: 'storage.sqlite', enabled: false })]);
  assert.equal(orderManifests(disabled).length, 0);
});

test('内置清单自洽：依赖都有提供者、id 唯一、entry 已解析', () => {
  const manifests = builtinManifests();
  const ids = new Set(manifests.map((item) => item.id));
  assert.equal(ids.size, manifests.length);
  assert.doesNotThrow(() => orderManifests(manifests));
  for (const item of manifests) {
    assert.match(item.entry, /^file:/);
  }
});

test('内核：插件访问未 inject 的服务被拒绝', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-kernel-'));
  try {
    const entry = path.join(temp, 'undeclared.mjs');
    await writeFile(
      entry,
      'export function apply(ctx) { ctx.service("storage"); }\n',
      'utf8',
    );
    const kernel = new Kernel(configFor(temp));
    await assert.rejects(
      kernel.load([manifest({ id: 'undeclared', entry: pathToFileURL(entry).href })]),
      /未在 inject 中声明/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('内核：消费缺权限时失败，并逆序回滚已加载插件', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-kernel-'));
  try {
    const marker = path.join(temp, 'disposed.txt');
    const providerEntry = path.join(temp, 'provider.mjs');
    const consumerEntry = path.join(temp, 'consumer.mjs');
    await writeFile(
      providerEntry,
      [
        'import { writeFileSync } from "node:fs";',
        'export function apply(ctx, config) {',
        '  ctx.provide("storage", { fake: true });',
        '  ctx.effect(() => writeFileSync(config.marker, "disposed"));',
        '}',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      consumerEntry,
      'export function apply(ctx) { ctx.service("storage"); }\n',
      'utf8',
    );

    const kernel = new Kernel(configFor(temp));
    await assert.rejects(
      kernel.load([
        manifest({
          id: 'provider',
          entry: pathToFileURL(providerEntry).href,
          provides: ['storage'],
          permissions: ['storage:provide', 'fs:data'],
          config: { marker },
        }),
        manifest({
          id: 'consumer',
          entry: pathToFileURL(consumerEntry).href,
          inject: ['storage'],
          permissions: ['storage:read'],
        }),
      ]),
      /缺少权限 storage:write/,
    );
    assert.equal(existsSync(marker), true, '回滚时执行了已加载插件的 disposer');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
