import { useState } from 'react';

import type { MemoryCandidateDto } from '../api.js';

export interface MemoryReviewProps {
  readonly candidates: readonly MemoryCandidateDto[];
  readonly busy: boolean;
  readonly onExtract: () => void;
  readonly onAccept: (id: string) => void;
  readonly onDismiss: (id: string) => void;
}

const KIND_LABEL: Record<MemoryCandidateDto['kind'], string> = {
  profile: '偏好',
  project: '项目规则',
  decision: '决定',
  lesson: '教训',
};

/**
 * 记忆候选审阅。
 *
 * 界面必须让用户明白：**这些还没有被记住**。
 * 自动记忆最大的风险是把错误沉淀成正确，所以必须由人点一下。
 */
export function MemoryReview(props: MemoryReviewProps): JSX.Element {
  const pending = props.candidates.filter((c) => c.status === 'pending');
  const [open, setOpen] = useState(false);

  return (
    <div className="memory-review">
      <div className="memory-head">
        <button type="button" className="link" onClick={() => setOpen((v) => !v)}>
          {open ? '收起记忆候选' : `记忆候选${pending.length > 0 ? `（${pending.length} 条待确认）` : ''}`}
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={props.onExtract}
          disabled={props.busy}
        >
          {props.busy ? '提炼中…' : '从最近对话提炼'}
        </button>
      </div>

      {open && (
        <div className="memory-body">
          {pending.length === 0 ? (
            <p className="muted small">
              没有待确认的候选。点「从最近对话提炼」可以看一眼有没有值得记下的东西。
            </p>
          ) : (
            <>
              <p className="muted small">
                下面这些<strong>还没有被记住</strong>。采纳后才会写进记忆并影响之后的对话。
              </p>
              <ul className="memory-list">
                {pending.map((c) => (
                  <li key={c.id}>
                    <div className="memory-meta">
                      <span className="memory-kind">{KIND_LABEL[c.kind]}</span>
                      <span className="muted small">
                        {c.scope === 'global' ? '全局' : '本项目'} · {c.source}
                      </span>
                    </div>
                    <p className="memory-text">{c.text}</p>
                    <div className="memory-actions">
                      <button type="button" className="ghost small" onClick={() => props.onDismiss(c.id)}>
                        忽略
                      </button>
                      <button type="button" className="primary small" onClick={() => props.onAccept(c.id)}>
                        记住
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
