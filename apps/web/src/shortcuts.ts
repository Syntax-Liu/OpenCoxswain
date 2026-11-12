/**
 * 全局键盘快捷键。
 *
 * ## 设计原则
 *
 * 1. **不和输入框抢键**。在 textarea / input 里打字时，只响应带修饰键的组合
 *    （Ctrl+K 可以，单独的 `/` 不行），否则用户打不出字。
 * 2. **不和浏览器抢键**。只用 Ctrl/Cmd 组合，避免占用 F5、Ctrl+W 这类
 *    用户预期由浏览器处理的键。
 * 3. **Esc 例外**：Esc 在任何地方都要能关闭当前弹层，包括输入框里。
 *
 * ## 键位表
 *
 * | 快捷键 | 动作 |
 * | --- | --- |
 * | `Ctrl+K` | 命令面板（项目/会话/动作） |
 * | `Ctrl+N` | 新对话 |
 * | `Ctrl+,` | 打开设置 |
 * | `Ctrl+B` | 折叠/展开侧栏 |
 * | `Ctrl+1..9` | 切换到第 N 个项目 |
 * | `Esc` | 关闭弹层 / 取消当前操作 |
 * | `Enter` | 发送（输入框内，Shift+Enter 换行） |
 */

export type ShortcutAction =
  | { readonly type: 'palette' }
  | { readonly type: 'new-conversation' }
  | { readonly type: 'open-settings' }
  | { readonly type: 'toggle-sidebar' }
  | { readonly type: 'escape' }
  | { readonly type: 'switch-project'; readonly index: number };

/** 一次按键的状态（只取需要的字段，便于测试）。 */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  /** 事件目标是否是可输入的控件。 */
  readonly inEditable?: boolean;
}

/** 判断事件是否发生在可输入元素里。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input' || tag === 'select') return true;
  return target.isContentEditable;
}

/**
 * 把一次按键翻译成动作。
 *
 * 返回 null 表示"不处理"——让事件继续冒泡给浏览器或输入框。
 */
export function resolveShortcut(event: KeyEventLike): ShortcutAction | null {
  const mod = event.ctrlKey === true || event.metaKey === true;

  // Esc：**任何地方都响应**，包括输入框里。
  // 用户在输入框里按 Esc 想关掉的是弹层，不是想取消输入。
  if (event.key === 'Escape') return { type: 'escape' };

  if (!mod) return null;

  // 输入框里只放行带修饰键的组合（到这里已经确认是 mod 组合）
  const key = event.key.toLowerCase();

  if (key === 'k') return { type: 'palette' };
  if (key === 'n') return { type: 'new-conversation' };
  if (key === ',') return { type: 'open-settings' };
  if (key === 'b') return { type: 'toggle-sidebar' };

  // Ctrl+1..9 切换项目
  if (/^[1-9]$/.test(key)) {
    return { type: 'switch-project', index: Number(key) - 1 };
  }

  return null;
}

/** 给人看的键位说明（设置页里的"快捷键"一节用）。 */
export interface ShortcutHelpItem {
  readonly keys: string;
  readonly action: string;
}

/** 按平台显示 Ctrl 还是 ⌘。 */
export function modifierLabel(isMac: boolean): string {
  // 用 \u 转义而不是裸字符：避免不同编辑器/编码保存时把符号改坏。
  // U+2318 = ⌘
  return isMac ? '\u2318' : 'Ctrl';
}

export function shortcutHelp(isMac: boolean): ShortcutHelpItem[] {
  const mod = modifierLabel(isMac);
  return [
    { keys: `${mod}+K`, action: '命令面板' },
    { keys: `${mod}+N`, action: '新对话' },
    { keys: `${mod}+,`, action: '打开设置' },
    { keys: `${mod}+B`, action: '折叠 / 展开侧栏' },
    { keys: `${mod}+1…9`, action: '切换到第 N 个项目' },
    { keys: 'Esc', action: '关闭弹层 / 取消当前操作' },
    { keys: 'Enter', action: '发送（Shift+Enter 换行）' },
  ];
}
