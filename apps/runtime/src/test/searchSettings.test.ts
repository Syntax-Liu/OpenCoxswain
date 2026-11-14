import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MemorySearchStore, SearchStore, isSearchConfigured } from '../settings/search.js';

describe('isSearchConfigured', () => {
  it('两个都填了才算配置', () => {
    assert.equal(isSearchConfigured({ endpoint: 'https://x', apiKey: 'k' }), true);
  });

  it('缺一个都不算', () => {
    assert.equal(isSearchConfigured({ endpoint: 'https://x', apiKey: '' }), false);
    assert.equal(isSearchConfigured({ endpoint: '', apiKey: 'k' }), false);
  });

  it('只有空白也不算', () => {
    assert.equal(isSearchConfigured({ endpoint: '   ', apiKey: 'k' }), false);
  });
});

describe('SearchStore', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ocx-search-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('文件不存在时返回空配置', async () => {
    const store = new SearchStore(join(dir, 'nope.json'));
    const s = await store.load();
    assert.equal(s.endpoint, '');
    assert.equal(s.apiKey, '');
    assert.equal(isSearchConfigured(s), false);
  });

  it('存了能读回来', async () => {
    const store = new SearchStore(join(dir, 'search.json'));
    await store.save({ endpoint: 'https://api.x.com/s', apiKey: 'secret' });
    const s = await store.load();
    assert.equal(s.endpoint, 'https://api.x.com/s');
    assert.equal(s.apiKey, 'secret');
    assert.equal(isSearchConfigured(s), true);
  });

  it('**损坏的 JSON 不炸，退回空配置**', async () => {
    const file = join(dir, 'broken.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{not json', 'utf8');
    const store = new SearchStore(file);
    const s = await store.load();
    assert.equal(s.endpoint, '');
  });

  it('非字符串字段被丢弃', async () => {
    const file = join(dir, 'weird.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ endpoint: 123, apiKey: null }), 'utf8');
    const store = new SearchStore(file);
    const s = await store.load();
    assert.equal(s.endpoint, '');
    assert.equal(s.apiKey, '');
  });
});

describe('MemorySearchStore', () => {
  it('默认未配置', async () => {
    const s = await new MemorySearchStore().load();
    assert.equal(isSearchConfigured(s), false);
  });

  it('存了立刻可读', async () => {
    const store = new MemorySearchStore();
    await store.save({ endpoint: 'e', apiKey: 'k' });
    assert.equal(isSearchConfigured(await store.load()), true);
  });
});
