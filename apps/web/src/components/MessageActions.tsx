import { useState } from 'react';

/**
 * 消息操作：复制、重发。
 *
 * 这两个是天天用得到但一直没做的功能。
 * 复制用于把 C 的结论贴到别处；重发用于"同一句话再来一次"——
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
  /** 提供后显示"重发"。 */
  readonly onResend?: () => void;
}

export function MessageActions(props: MessageActionsProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <span className="msg-actions">
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
      {props.onResend && (
        <button type="button" className="link" title="把这句重新发给助理" onClick={props.onResend}>
          重发
        </button>
      )}
    </span>
  );
}
