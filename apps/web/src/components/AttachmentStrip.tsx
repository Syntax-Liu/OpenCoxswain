import type { Attachment } from './attachments.js';
import { describeAttachment } from './attachments.js';

/**
 * 附件预览条：显示在输入框上方。
 *
 * 图片给缩略图，文本/二进制给图标 + 文件名。
 * 每个都能单独删除——用户拖错了要能撤。
 */
export interface AttachmentStripProps {
  readonly attachments: readonly Attachment[];
  readonly onRemove: (id: string) => void;
}

export function AttachmentStrip(props: AttachmentStripProps): JSX.Element | null {
  if (props.attachments.length === 0) return null;

  return (
    <div className="attachment-strip">
      {props.attachments.map((att) => (
        <div
          key={att.id}
          className={`attachment-chip${att.warning ? ' has-warning' : ''}`}
          title={att.warning ?? describeAttachment(att)}
        >
          {att.kind === 'image' && att.dataUrl ? (
            <img className="attachment-thumb" src={att.dataUrl} alt={att.name} />
          ) : (
            <span className="attachment-icon" aria-hidden>
              {att.kind === 'text' ? '▤' : '▦'}
            </span>
          )}

          <span className="attachment-name">{att.name}</span>

          {att.warning && <span className="attachment-warn">!</span>}

          <button
            type="button"
            className="attachment-remove"
            title="移除"
            aria-label={`移除 ${att.name}`}
            onClick={() => props.onRemove(att.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
