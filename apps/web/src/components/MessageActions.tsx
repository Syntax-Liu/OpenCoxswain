import { useState } from 'react';

import { IconCheck, IconCopy, IconEdit, IconRetry } from './icons.js';
import { actionsFor, type MessageRole } from './messageCapabilities.js';
import { IconButton } from '../ui/index.js';

/**
 * 消息操作：重试、编辑、重发、复制。
 *
 * ## 为什么是圆形图标按钮
 *
 * 用户指着 DSH 的截图说：
 * > 编辑重发复制，我让你参考 DSH，你看不见吗？
 *
 * DSH 那一排是**小的圆形图标按钮**，紧贴消息内容下方左侧，平时就显示。
 * 之前做成文字链（"编辑""重发""复制"），又长又占地方。
 *
 * ## 为什么没有点赞/点踩
 *
 * DSH 的点赞会发到官方服务器。我们**没有这个后端**——
 * 运行时里没有任何 feedback 接口，做出来的只能是图标变个颜色。
 * 装饰性的假功能比没有功能更糟：用户会以为反馈被记录了。
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
        <IconButton onClick={props.onRetry} label={"重新回答"}><IconRetry size={14} /></IconButton>
      )}

      {available.canEdit && props.onEdit && (
        <IconButton onClick={props.onEdit} label={"编辑后重发"}><IconEdit size={14} /></IconButton>
      )}

      {available.canResend && props.onResend && (
        <IconButton onClick={props.onResend} label={"原样重发"}><IconRetry size={14} /></IconButton>
      )}

      {available.canCopy && (
        <IconButton onClick={async () => {
            const ok = await copyText(props.content);
            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }} label={copied ? '已复制' : '复制'} className={`${copied ? ' done' : ''}`}>{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}</IconButton>
      )}
    </span>
  );
}
