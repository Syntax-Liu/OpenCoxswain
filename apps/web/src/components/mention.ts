/**
 * @ 引用的纯逻辑（不依赖 React，可单独测试）。
 *
 * ## 为什么要分开
 *
 * 检测和替换是纯函数，测试它们不该拉起整个 React 组件树。
 * 组件只负责渲染，逻辑都在这里。
 */

/** @ 引用的当前状态。 */
export interface MentionState {
  readonly active: boolean;
  /** @ 之后的查询文本。 */
  readonly query: string;
  /** @ 在文本里的位置（用于替换）；未激活为 -1。 */
  readonly start: number;
}

/**
 * 判断当前是否在输入 @ 引用。
 *
 * 规则：光标前最近的 @ 与光标之间**没有空白**。
 *
 * 这条规则的作用：`发邮件 @张三 说` 里的 @ 不会触发文件选择——
 * 那个 @ 是普通文本，不是引用。误弹出比不弹更烦人。
 */
export function detectMention(text: string, caret: number): MentionState {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return { active: false, query: '', start: -1 };

  const query = before.slice(at + 1);
  // 有空白或换行就不再是引用
  if (/\s/.test(query)) return { active: false, query: '', start: -1 };

  return { active: true, query, start: at };
}

/** 把 @ 引用替换成确认后的文件路径。 */
export function applyMention(text: string, state: MentionState, filePath: string): string {
  if (!state.active || state.start < 0) return text;
  const before = text.slice(0, state.start);
  const after = text.slice(state.start + 1 + state.query.length);
  // 后面自动补一个空格，方便继续打字
  return `${before}@${filePath} ${after}`;
}
