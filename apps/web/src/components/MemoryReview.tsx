import { useState } from 'react';

import type { MemoryCandidateDto } from '../api.js';
import { Button, OptionItem, TextButton } from '../ui/index.js';

export interface MemoryEntryView {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly source: string;
}

export interface MemoryReviewProps {
  readonly candidates: readonly MemoryCandidateDto[];
  readonly active: { global: readonly MemoryEntryView[]; project: readonly MemoryEntryView[] };
  readonly busy: boolean;
  readonly onExtract: () => void;
  readonly onAccept: (id: string) => void;
  readonly onDismiss: (id: string) => void;
  readonly onForget: (scope: 'global' | 'project', entryId: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  profile: '偏好',
  project: '项目规则',
  decision: '决定',
  lesson: '教训',
};

/**
 * 记忆面板：候选审阅 + 已生效记忆管理。
 *
 * 两个区都必须存在：
 * - **候选区**让人决定"要不要记"（自动记忆的安全阀）；
 * - **已生效区**让人看见"它到底记住了什么"、并能删掉。
 *
 * 没有已生效区的话，用户不知道 AI 脑子里的东西从哪来，也不敢放心让它自己记。
 */
export function MemoryReview(props: MemoryReviewProps): JSX.Element {
  const pending = props.candidates.filter((c) => c.status === 'pending');
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'pending' | 'active'>('pending');

  const totalActive = props.active.global.length + props.active.project.length;

  return (
    <div className="memory-review">
      <div className="memory-head">
        <TextButton onClick={() => setOpen((v) => !v)}>{open ? '收起记忆' : `记忆（${pending.length} 待确认，已记 ${totalActive}）`}</TextButton>
        <Button onClick={props.onExtract} disabled={props.busy} variant="ghost" size="sm">{props.busy ? '提炼中…' : '从最近对话提炼'}</Button>
      </div>

      {open && (
        <div className="memory-body">
          <div className="memory-tabs">
            <OptionItem
              selected={tab === 'pending'}
              onClick={() => setTab('pending')}
            >
              待确认 {pending.length > 0 ? `(${pending.length})` : ''}
            </OptionItem>
            <OptionItem
              selected={tab === 'active'}
              onClick={() => setTab('active')}
            >
              已生效 ({totalActive})
            </OptionItem>
          </div>

          {tab === 'pending' &&
            (pending.length === 0 ? (
              <p className="muted small">
                没有待确认的候选。点「从最近对话提炼」看一眼有没有值得记下的东西。
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
                        <span className="memory-kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                        <span className="muted small">
                          {c.scope === 'global' ? '全局' : '本项目'}<span className="meta-gap">{c.source}</span>
                        </span>
                      </div>
                      <p className="memory-text">{c.text}</p>
                      <div className="memory-actions">
                        <Button onClick={() => props.onDismiss(c.id)} variant="ghost" size="sm">忽略
                        </Button>
                        <Button onClick={() => props.onAccept(c.id)} size="sm">记住
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ))}

          {tab === 'active' &&
            (totalActive === 0 ? (
              <p className="muted small">还没有记住任何东西。</p>
            ) : (
              <>
                <ActiveGroup
                  title="全局（所有项目）"
                  entries={props.active.global}
                  onForget={(id) => props.onForget('global', id)}
                />
                <ActiveGroup
                  title="本项目"
                  entries={props.active.project}
                  onForget={(id) => props.onForget('project', id)}
                />
              </>
            ))}
        </div>
      )}
    </div>
  );
}

function ActiveGroup({
  title,
  entries,
  onForget,
}: {
  title: string;
  entries: readonly MemoryEntryView[];
  onForget: (id: string) => void;
}): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="memory-group">
      <p className="muted small">{title}</p>
      <ul className="memory-list">
        {entries.map((e) => (
          <li key={e.id}>
            <div className="memory-meta">
              <span className="memory-kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span className="muted small">{e.source}</span>
              <TextButton style={{ marginLeft: 'auto' }} onClick={() => onForget(e.id)}>忘记
              </TextButton>
            </div>
            <p className="memory-text">{e.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
