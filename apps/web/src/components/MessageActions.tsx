import { useState } from 'react';

import { actionsFor, type MessageRole } from './messageCapabilities.js';

/**
 * 消息操作：复制、重发。
 *
 * 这两个是天天用得到但一直没做的功能。
 * 复制用于把 Assistant 的结论贴到别处；重发用于"同一句话再来一次"——
 * 之前只能手动选中复制，很别扭。
 */

/**
 * 复制到剪贴板。
 *
 * 不用 `navigator.clipboard` 的原因：它在非 HTTPS 下不可用，
 * 而桌面壳虽然可信，但便携版/局域网访问时可能是 http，
 * 所以保留一个 `execCommand` 兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到兜底
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export interface MessageActionsProps {
  readonly content: string;
  /** 消息角色与来源，用于决定显示哪些操作。 */
  readonly role?: MessageRole;
  readonly source?: string;
  /** 重试：让 Assistant 重新回答这个问题。 */
  readonly onRetry?: () => void;
  /** 编辑：改一下用户自己发的话再发。 */
  readonly onEdit?: () => void;
  /** 重发：原样再发一次。 */
  readonly onResend?: () => void;
}

export function MessageActions(props: MessageActionsProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  // 没传角色时按"只能复制"处理——保守，不会多出不合适的按钮
  const available = props.role
    ? actionsFor({ role: props.role, content: props.content, ...(props.source ? { source: props.source } : {}) })
    : { canRetry: false, canEdit: false, canCopy: true, canResend: false };

  return (
    <span className="msg-actions">
      {available.canRetry && props.onRetry && (
        <button type="button" className="link" title="让它重新回答一次" onClick={props.onRetry}>
          重试
        </button>
      )}
      {available.canEdit && props.onEdit && (
        <button type="button" className="link" title="改一下再发" onClick={props.onEdit}>
          编辑
        </button>
      )}
      {available.canResend && props.onResend && (
        <button type="button" className="link" title="原样再发一次" onClick={props.onResend}>
          重发
        </button>
      )}
      {available.canCopy && (
        <button
          type="button"
          className="link"
          title="复制这条消息"
          onClick={async () => {
            const ok = await copyText(props.content);
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      )}
    </span>
  );
}
