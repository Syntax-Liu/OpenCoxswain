/**
 * 快捷键测试。
 *
 * 核心约束：**不能和输入框抢键**。
 * 用户在打字时按普通键，必须让它进到输入框里，而不是被拦截成命令。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveShortcut, shortcutHelp, type KeyEventLike } from '../shortcuts.js';

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('常用快捷键', () => {
  it('Ctrl+K 打开命令面板', () => {
    assert.deepEqual(resolveShortcut(key('k', { ctrlKey: true })), { type: 'palette' });
  });

  it('Ctrl+N 新对话', () => {
    assert.deepEqual(resolveShortcut(key('n', { ctrlKey: true })), { type: 'new-conversation' });
  });

  it('Ctrl+, 打开设置', () => {
    assert.deepEqual(resolveShortcut(key(',', { ctrlKey: true })), { type: 'open-settings' });
  });

  it('Ctrl+B 折叠侧栏', () => {
    assert.deepEqual(resolveShortcut(key('b', { ctrlKey: true })), { type: 'toggle-sidebar' });
  });

  it('大写也能识别（按住 Shift 时）', () => {
    assert.deepEqual(resolveShortcut(key('K', { ctrlKey: true, shiftKey: true })), { type: 'palette' });
  });
});

describe('Mac 的 ⌘', () => {
  it('metaKey 等同于 ctrlKey', () => {
    assert.deepEqual(resolveShortcut(key('k', { metaKey: true })), { type: 'palette' });
    assert.deepEqual(resolveShortcut(key('n', { metaKey: true })), { type: 'new-conversation' });
  });
});

describe('项目切换', () => {
  it('Ctrl+1 切到第一个项目', () => {
    assert.deepEqual(resolveShortcut(key('1', { ctrlKey: true })), { type: 'switch-project', index: 0 });
  });

  it('Ctrl+9 切到第九个', () => {
    assert.deepEqual(resolveShortcut(key('9', { ctrlKey: true })), { type: 'switch-project', index: 8 });
  });

  it('Ctrl+0 不处理（没有第 0 个）', () => {
    assert.equal(resolveShortcut(key('0', { ctrlKey: true })), null);
  });
});

describe('Esc', () => {
  it('**在任何地方都响应**（包括输入框）', () => {
    assert.deepEqual(resolveShortcut(key('Escape', { inEditable: true })), { type: 'escape' });
    assert.deepEqual(resolveShortcut(key('Escape')), { type: 'escape' });
  });

  it('带修饰键的 Esc 也当 Esc', () => {
    assert.deepEqual(resolveShortcut(key('Escape', { ctrlKey: true })), { type: 'escape' });
  });
});

describe('**不和普通输入抢键**', () => {
  it('普通字母不触发（要能正常打字）', () => {
    assert.equal(resolveShortcut(key('k')), null);
    assert.equal(resolveShortcut(key('n')), null);
    assert.equal(resolveShortcut(key('a')), null);
  });

  it('单按 `/` 不触发（要能打出斜杠）', () => {
    assert.equal(resolveShortcut(key('/')), null);
  });

  it('单按 `@` 不触发（@ 引用是输入框自己的事）', () => {
    assert.equal(resolveShortcut(key('@')), null);
  });

  it('Enter 不被全局拦截（发送由输入框自己处理）', () => {
    assert.equal(resolveShortcut(key('Enter')), null);
  });

  it('Tab 不被拦截（焦点导航要正常）', () => {
    assert.equal(resolveShortcut(key('Tab')), null);
  });
});

describe('不占用浏览器常用键', () => {
  it('F5 / Ctrl+R 刷新不拦', () => {
    assert.equal(resolveShortcut(key('F5')), null);
    assert.equal(resolveShortcut(key('r', { ctrlKey: true })), null);
  });

  it('Ctrl+W 关标签不拦', () => {
    assert.equal(resolveShortcut(key('w', { ctrlKey: true })), null);
  });

  it('Ctrl+C / V 不拦（复制粘贴）', () => {
    assert.equal(resolveShortcut(key('c', { ctrlKey: true })), null);
    assert.equal(resolveShortcut(key('v', { ctrlKey: true })), null);
  });

  it('Ctrl+A / Z 不拦（全选、撤销）', () => {
    assert.equal(resolveShortcut(key('a', { ctrlKey: true })), null);
    assert.equal(resolveShortcut(key('z', { ctrlKey: true })), null);
  });
});

describe('键位说明', () => {
  it('Windows 显示 Ctrl', () => {
    const help = shortcutHelp(false);
    assert.ok(help.some((h) => h.keys === 'Ctrl+K'));
  });

  it('Mac 显示 ⌘', () => {
    const help = shortcutHelp(true);
    // \u2318 = ⌘；键位带加号，和 Windows 的 "Ctrl+K" 保持一致的写法
    assert.ok(help.some((h) => h.keys === '\u2318+K'), 'Mac 上应显示 ⌘+K');
  });

  it('包含所有已实现的快捷键', () => {
    const help = shortcutHelp(false);
    const keys = help.map((h) => h.keys).join(',');
    for (const expected of ['Ctrl+K', 'Ctrl+N', 'Ctrl+,', 'Ctrl+B', 'Ctrl+1…9', 'Esc']) {
      assert.ok(keys.includes(expected), `缺少 ${expected}`);
    }
  });
});
