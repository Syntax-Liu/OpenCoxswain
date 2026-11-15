/**
 * 侧栏宽度测试。
 *
 * 这组测试守的是一个真实 bug：
 * App 里的网格列宽写死 244，而 Sidebar 从 localStorage 读（可能是 384）。
 * 两边初始值不一致 → 重启后侧栏被网格列压住，拖一下才恢复正常。
 *
 * 现在两边都从 `sidebarWidth.ts` 读，同一个来源就不会再错位。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
  readSavedSidebarWidth,
  saveSidebarWidth,
} from '../sidebarWidth.js';

/** 简易 localStorage 替身。 */
function stubStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  restore: () => void;
} {
  const store = { ...initial };
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
  return {
    store,
    restore: () => {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    },
  };
}

describe('侧栏宽度', () => {
  it('没有存过时用默认值', () => {
    const { restore } = stubStorage();
    try {
      assert.equal(readSavedSidebarWidth(), DEFAULT_SIDEBAR_WIDTH);
    } finally {
      restore();
    }
  });

  it('**读到保存的值**（这是重启后不错位的关键）', () => {
    const { restore } = stubStorage({ 'ocx.sidebarWidth': '380' });
    try {
      assert.equal(readSavedSidebarWidth(), 380);
    } finally {
      restore();
    }
  });

  it('超范围的值被夹回合法区间', () => {
    const { restore } = stubStorage({ 'ocx.sidebarWidth': '9999' });
    try {
      assert.equal(readSavedSidebarWidth(), MAX_SIDEBAR_WIDTH);
    } finally {
      restore();
    }
  });

  it('坏数据退回默认值', () => {
    const { restore } = stubStorage({ 'ocx.sidebarWidth': 'abc' });
    try {
      assert.equal(readSavedSidebarWidth(), DEFAULT_SIDEBAR_WIDTH);
    } finally {
      restore();
    }
  });

  it('写入后再读出来一致', () => {
    const { store, restore } = stubStorage();
    try {
      saveSidebarWidth(300);
      assert.equal(store['ocx.sidebarWidth'], '300');
      assert.equal(readSavedSidebarWidth(), 300);
    } finally {
      restore();
    }
  });

  it('夹取边界', () => {
    assert.equal(clampSidebarWidth(10), MIN_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(9999), MAX_SIDEBAR_WIDTH);
    assert.equal(clampSidebarWidth(250), 250);
    assert.equal(clampSidebarWidth(Number.NaN), DEFAULT_SIDEBAR_WIDTH);
  });

  it('localStorage 不可用时回退默认值（不抛异常）', () => {
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    try {
      assert.equal(readSavedSidebarWidth(), DEFAULT_SIDEBAR_WIDTH);
      saveSidebarWidth(300); // 不该抛
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });
});
