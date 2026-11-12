/**
 * 首次引导测试。
 *
 * 核心约束：**只显示一次**。
 * 每次都弹同一个引导，比没有引导更烦人。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  STARTER_EXAMPLES,
  markOnboardingSeen,
  resetOnboarding,
  shouldShowOnboarding,
} from '../components/starterGuide.js';

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

describe('显示时机', () => {
  it('**没看过时显示**', () => {
    assert.equal(shouldShowOnboarding(), true);
  });

  it('**看过之后不再显示**', () => {
    markOnboardingSeen();
    assert.equal(shouldShowOnboarding(), false);
  });

  it('reset 之后又显示（用于"重新看一遍"）', () => {
    markOnboardingSeen();
    resetOnboarding();
    assert.equal(shouldShowOnboarding(), true);
  });

  it('**localStorage 不可用时不显示**（宁可不打扰）', () => {
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
    assert.equal(shouldShowOnboarding(), false);

    // 这两个不该抛
    markOnboardingSeen();
    resetOnboarding();

    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });
});

describe('示例内容', () => {
  it('有三条示例', () => {
    assert.equal(STARTER_EXAMPLES.length, 3);
  });

  it('每条都有标题、提示和实际发送的文本', () => {
    for (const example of STARTER_EXAMPLES) {
      assert.ok(example.title.length > 0, '标题不能为空');
      assert.ok(example.prompt.length > 0, 'prompt 不能为空');
      assert.ok(example.hint.length > 0, 'hint 不能为空');
    }
  });

  it('**有一条能体现并发**（这是本产品和其他产品最大的不同）', () => {
    assert.ok(STARTER_EXAMPLES.some((e) => e.id === 'parallel'));
  });

  it('id 不重复', () => {
    const ids = STARTER_EXAMPLES.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('prompt 是能让它直接干活的完整指令，不是空泛的话', () => {
    for (const example of STARTER_EXAMPLES) {
      // 至少要说清"做什么"，所以得有一定长度
      assert.ok(example.prompt.length >= 10, `${example.title} 的 prompt 太短`);
    }
  });
});
