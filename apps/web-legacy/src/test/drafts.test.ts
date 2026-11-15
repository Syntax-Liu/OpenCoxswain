/**
 * 草稿测试。
 *
 * 核心约束：**不同视图的草稿不能串**。
 * 对 A 项目说了一半，切到 B 项目，看到 A 的半句话会让人以为打错地方了。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_DRAFT_LENGTH, clearDraft, draftKey, loadDraft, saveDraft } from '../drafts.js';

/** 最小 localStorage 替身（Node 里没有这个 API）。 */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const storage = new MemoryStorage();

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  storage.clear();
});

afterEach(() => {
  storage.clear();
});

describe('存储键', () => {
  it('不同的 Agent 各自一份', () => {
    const a = draftKey({ kind: 'executor', projectId: 'p1', executorId: 'e1' });
    const b = draftKey({ kind: 'executor', projectId: 'p1', executorId: 'e2' });
    assert.notEqual(a, b);
  });

  it('**不同项目的 Assistant 各自一份**', () => {
    const a = draftKey({ kind: 'assistant', projectId: 'p1' });
    const b = draftKey({ kind: 'assistant', projectId: 'p2' });
    assert.notEqual(a, b);
  });

  it('同一个视图稳定复现', () => {
    const a = draftKey({ kind: 'assistant', projectId: 'p1' });
    const b = draftKey({ kind: 'assistant', projectId: 'p1' });
    assert.equal(a, b);
  });

  it('全局视图有独立的键', () => {
    assert.ok(draftKey({ kind: 'global' }).includes('global'));
  });
});

describe('存取', () => {
  it('存了能读回来', () => {
    const key = draftKey({ kind: 'assistant', projectId: 'p1' });
    saveDraft(key, '打了一半的话');
    assert.equal(loadDraft(key), '打了一半的话');
  });

  it('没存过时返回空串', () => {
    assert.equal(loadDraft('ocx.draft.nothing'), '');
  });

  it('**不同视图互不影响**', () => {
    const k1 = draftKey({ kind: 'assistant', projectId: 'p1' });
    const k2 = draftKey({ kind: 'assistant', projectId: 'p2' });
    saveDraft(k1, 'A 的内容');
    saveDraft(k2, 'B 的内容');
    assert.equal(loadDraft(k1), 'A 的内容');
    assert.equal(loadDraft(k2), 'B 的内容');
  });

  it('**空内容会删掉键**（不留垃圾）', () => {
    const key = draftKey({ kind: 'assistant', projectId: 'p1' });
    saveDraft(key, '有内容');
    saveDraft(key, '   ');
    assert.equal(loadDraft(key), '');
  });

  it('clearDraft 能清掉', () => {
    const key = draftKey({ kind: 'assistant', projectId: 'p1' });
    saveDraft(key, '内容');
    clearDraft(key);
    assert.equal(loadDraft(key), '');
  });
});

describe('边界', () => {
  it('**超长草稿被截断**（多半是误粘贴）', () => {
    const key = draftKey({ kind: 'assistant', projectId: 'p1' });
    saveDraft(key, 'x'.repeat(MAX_DRAFT_LENGTH + 5000));
    assert.ok((loadDraft(key).length ?? 0) <= MAX_DRAFT_LENGTH);
  });

  it('localStorage 不可用时不崩', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    assert.equal(loadDraft('any'), '');
    // 下面两个不该抛
    saveDraft('any', 'text');
    clearDraft('any');
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  it('多行内容原样保留', () => {
    const key = draftKey({ kind: 'assistant', projectId: 'p1' });
    const text = '第一行\n第二行\n\n第四行';
    saveDraft(key, text);
    assert.equal(loadDraft(key), text);
  });
});
