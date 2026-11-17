import type { Attachment } from './attachments.js';
import { describeAttachment } from './attachments.js';
import { IconButton } from '../ui/index.js';

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
          className={`btn btn--secondary btn--sm attachment-chip${att.warning ? ' has-warning' : ''}`}
          title={att.warning ?? describeAttachment(att)}
          /* **原生 View Transitions**（desktop-agent-ui：附件卡片过渡流畅度）。
           *
           * 用 id 命名，浏览器就能在增删/换位时把**同一个** chip 从旧位置
           * 平移到新位置，而不是让它瞬间跳过去。
           *
           * 这是纯声明式：不支持的 WebView 会直接忽略这个未知属性，
           * 行为与改动前完全一致——不需要写任何能力探测或降级分支。 */
          style={{ viewTransitionName: `attach-${att.id}` }}
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

          <IconButton
            label={`移除 ${att.name}`}
            title="移除"
            onClick={() => props.onRemove(att.id)}
          >
            ×
          </IconButton>
        </div>
      ))}
    </div>
  );
}
