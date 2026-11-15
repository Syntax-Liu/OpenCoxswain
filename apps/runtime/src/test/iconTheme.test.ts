import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_ICON_THEME,
  IconThemeStore,
  MemoryIconThemeStore,
  normalizeIconTheme,
} from '../settings/iconTheme.js';

/**
 * 图标配色的落盘存储。
 *
 * ## 为什么不能只存 localStorage
 *
 * 窗口和托盘图标是 **Tauri(Rust) 画的**，网页的 localStorage 它读不到。
 * 所以切换时要落一份 JSON 给壳层读——没有这份文件，
 * 用户在设置里换了配色，界面变了但托盘还是旧的。
 */
describe('图标配色归一', () => {
  it('紫罗兰是默认', () => {
    assert.equal(DEFAULT_ICON_THEME, 'violet');
  });

  it('六个合法值都认', () => {
    for (const id of ['violet', 'sky', 'coral', 'deep', 'graphite', 'mint']) {
      assert.equal(normalizeIconTheme(id), id);
    }
  });

  it('**非法值退回默认**，不抛错', () => {
    for (const bad of ['', 'nope', null, undefined, 42, {}]) {
      assert.equal(normalizeIconTheme(bad), 'violet');
    }
  });
});

describe('IconThemeStore', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocx-icon-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不存在时返回默认', async () => {
    const store = new IconThemeStore(join(dir, 'none.json'));
    assert.equal(await store.load(), 'violet');
  });

  it('存了能读回来', async () => {
    const store = new IconThemeStore(join(dir, 'ok.json'));
    await store.save('mint');
    assert.equal(await store.load(), 'mint');
  });

  it('存的是 JSON，壳层能直接解析', async () => {
    const file = join(dir, 'json.json');
    const store = new IconThemeStore(file);
    await store.save('deep');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { theme?: string };
    assert.equal(raw.theme, 'deep');
  });

  it('**写入时也归一**：非法值不会落盘', async () => {
    const file = join(dir, 'bad.json');
    const store = new IconThemeStore(file);
    await store.save('not-a-theme');
    const raw = JSON.parse(await readFile(file, 'utf8')) as { theme?: string };
    assert.equal(raw.theme, 'violet');
  });

  it('**损坏的 JSON 不炸**', async () => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{not json', 'utf8');
    const store = new IconThemeStore(file);
    assert.equal(await store.load(), 'violet');
  });
});

describe('MemoryIconThemeStore', () => {
  it('默认紫罗兰', async () => {
    assert.equal(await new MemoryIconThemeStore().load(), 'violet');
  });

  it('存了立刻可读', async () => {
    const store = new MemoryIconThemeStore();
    await store.save('coral');
    assert.equal(await store.load(), 'coral');
  });
});
