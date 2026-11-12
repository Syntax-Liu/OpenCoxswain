/**
 * 消息操作：重试 / 编辑 / 复制。
 *
 * ## 三种操作，三种场景
 *
 * | 操作 | 作用于 | 场景 |
 * | --- | --- | --- |
 * | **重试** | Assistant 的回答 | 答得不好，想让它重新说一次 |
 * | **编辑** | 用户自己发的消息 | 打错字了，改一下重新发 |
 * | 复制 | 任意消息 | 把结论贴到别处 |
 *
 * ## 一个刻意的取舍：不做"回退上下文"
 *
 * "重试"在多数产品里会**删掉之前那条回答再重生成**。
 * 我们不这么做，而是**再发一次同样的请求**。
 *
 * 理由：这个产品的核心承诺之一是"轨迹可回看、副作用可查"。
 * 如果重试会静默删掉历史，那条记录了"它当时怎么答的"的证据就没了——
 * 而这恰恰是出事时最需要的东西。
 *
 * 所以重试的表现是：历史保留，追加一次新的尝试。
 * 用户可以清楚看到"第一次怎么答、第二次怎么答"。
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** 一条消息能有哪些操作。 */
export interface AvailableActions {
  readonly canRetry: boolean;
  readonly canEdit: boolean;
  readonly canCopy: boolean;
  readonly canResend: boolean;
}

/**
 * 判断一条消息能做哪些操作。
 *
 * 规则：
 * - **Assistant 消息**：重试（重新生成）+ 复制
 * - **用户消息**：编辑（改完重发）+ 重发（原样再来一次）+ 复制
 * - 内部通知（source 以 internal: 开头）：只能复制——
 *   它是系统消息，重试/编辑都没有意义
 */
export function actionsFor(message: {
  readonly role: MessageRole;
  readonly source?: string;
  readonly content: string;
}): AvailableActions {
  const internal = (message.source ?? '').startsWith('internal:');
  const copyable = message.content.trim().length > 0;

  if (internal) {
    return { canRetry: false, canEdit: false, canCopy: copyable, canResend: false };
  }

  if (message.role === 'assistant') {
    return { canRetry: true, canEdit: false, canCopy: copyable, canResend: false };
  }

  if (message.role === 'user') {
    return { canRetry: false, canEdit: true, canCopy: copyable, canResend: true };
  }

  return { canRetry: false, canEdit: false, canCopy: copyable, canResend: false };
}

/** 编辑框的初始值：去掉附件标记，只留用户自己打的字。 */
export function editableText(content: string): string {
  // 附件是被拼进内容的（【附件：xxx】…），编辑时不该让用户看到那一大坨
  const withoutAttachments = content.replace(/【附件：[^】]*】[\s\S]*?```[\s\S]*?```/g, '').trim();
  return withoutAttachments || content.trim();
}
