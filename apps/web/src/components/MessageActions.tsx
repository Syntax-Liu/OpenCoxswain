/**
 * 单条消息的操作：复制 / 重试 / 编辑。
 *
 * 能力判断复用 messageCapabilities.ts（旧界面验证过的规则）：
 * - Assistant 消息：重试（再生成一次）+ 复制
 * - 用户消息：编辑（改完重发）+ 复制
 * - 内部通知：只能复制
 *
 * 重试的语义是**追加一次新尝试**，不删历史——这个产品的承诺是"轨迹可回看"，
 * 静默删掉历史就丢掉了"它当时怎么答的"这个证据。
 */
import { useCallback, useState } from 'react';
import { actionsFor, type MessageRole } from './messageCapabilities.js';

export interface MessageActionsProps {
  readonly role: MessageRole;
  readonly source?: string;
  readonly content: string;
  readonly onRetry?: () => void;
  readonly onEdit?: (next: string) => void;
}

export function MessageActions(props: MessageActionsProps): JSX.Element | null {
  const available = actionsFor({
    role: props.role,
    source: props.source,
    content: props.content,
  });

  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.content);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(props.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }, [props.content]);

  const submitEdit = useCallback(() => {
    const v = draft.trim();
    if (!v || v === props.content) {
      setEditing(false);
      return;
    }
    props.onEdit?.(v);
    setEditing(false);
  }, [draft, props]);

  if (!available.canRetry && !available.canEdit && !available.canCopy) return null;

  if (editing) {
    return (
      <div className="msg-edit">
        <textarea
          className="decision-input"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submitEdit();
            }
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div className="msg-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={submitEdit}>
            重发
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setEditing(false);
              setDraft(props.content);
            }}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-actions">
      {available.canCopy && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={copy}
          title="复制这条消息"
        >
          {copied ? '已复制' : '复制'}
        </button>
      )}
      {available.canRetry && props.onRetry && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={props.onRetry}
          title="让它重新回答一次（保留这次）"
        >
          重试
        </button>
      )}
      {available.canEdit && props.onEdit && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setEditing(true)}
          title="改了重新发"
        >
          编辑
        </button>
      )}
    </div>
  );
}
