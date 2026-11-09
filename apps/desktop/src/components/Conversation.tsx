import { useEffect, useRef, useState } from 'react';
import type { Message, Task } from '@opencoxswain/shared';
import type { TaskAction } from '../api.js';
import { formatTime, MarkdownLite, StatusChip } from '../ui.js';

interface Props {
  messages: Message[];
  root: Task | null;
  children: Task[];
  busy: boolean;
  onPlan: (goal: string, acceptanceCommand?: string) => Promise<boolean>;
  onAction: (action: TaskAction, note?: string) => void;
}

export function Conversation({
  messages,
  root,
  children,
  busy,
  onPlan,
  onAction,
}: Props): JSX.Element {
  const [goal, setGoal] = useState('');
  const [command, setCommand] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, root?.status]);

  const active = root !== null && !['done', 'cancelled', 'failed'].includes(root.status);
  const awaitingApproval = root?.status === 'awaiting_approval';

  const submit = async (): Promise<void> => {
    if (!goal.trim() || busy || active) return;
    const ok = await onPlan(goal.trim(), command.trim() || undefined);
    if (ok) {
      setGoal('');
      setCommand('');
    }
  };

  return (
    <section className="panel conversation">
      <header className="panel-header">
        <h2>总管对话</h2>
        {root ? <StatusChip status={root.status} /> : null}
      </header>

      <div className="panel-body messages">
        {messages.length === 0 ? (
          <p className="placeholder">
            对总管说一句你想完成的事。它会先给出任务单，等你确认后才派发员工。
          </p>
        ) : null}
        {messages.map((message) => (
          <article className="message" data-role={message.role} key={message.id}>
            <div className="message-meta">
              <span>{message.role === 'user' ? '你' : message.role === 'assistant' ? '总管' : '系统'}</span>
              <time>{formatTime(message.createdAt)}</time>
            </div>
            {message.role === 'assistant' ? (
              <MarkdownLite text={message.content} />
            ) : (
              <p className="plain">{message.content}</p>
            )}
          </article>
        ))}

        {awaitingApproval && root ? (
          <article className="approval-card">
            <h3>执行清单确认</h3>
            <p>{root.goal}</p>
            <ul>
              {children.map((child) => (
                <li key={child.id}>
                  <span className="role-tag">{child.contract.assignee?.role ?? '—'}</span>
                  {child.title}
                </li>
              ))}
            </ul>
            <dl className="inline-facts">
              <div>
                <dt>预算</dt>
                <dd>
                  ${(root.contract.budget.usd ?? 0).toFixed(2)} /{' '}
                  {(root.contract.budget.tokens ?? 0).toLocaleString()} tokens /{' '}
                  {root.contract.budget.minutes ?? 0} 分钟
                </dd>
              </div>
              <div>
                <dt>写入范围</dt>
                <dd>
                  {children
                    .flatMap((child) => child.contract.write_scope ?? [])
                    .join('、') || '只读'}
                </dd>
              </div>
            </dl>
            {rejecting ? (
              <div className="reject-box">
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="打回原因（可选）"
                />
                <div className="row">
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      onAction('reject', note.trim() || undefined);
                      setRejecting(false);
                      setNote('');
                    }}
                  >
                    确认打回
                  </button>
                  <button disabled={busy} onClick={() => setRejecting(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => onAction('approve')}>
                  确认开工
                </button>
                <button disabled={busy} onClick={() => setRejecting(true)}>
                  打回
                </button>
              </div>
            )}
          </article>
        ) : null}
        <div ref={bottom} />
      </div>

      <footer className="composer">
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              void submit();
            }
          }}
          placeholder={active ? '当前有进行中的任务，完成或取消后再开始新目标' : '例如：修复夜间模式切换后不生效'}
          rows={3}
          disabled={active}
        />
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="验收命令（可选），例如：npm test"
          disabled={active}
        />
        <div className="row">
          <span className="hint">Ctrl+Enter 发送</span>
          <button className="primary" onClick={() => void submit()} disabled={busy || active || !goal.trim()}>
            {busy ? '处理中…' : '交给总管'}
          </button>
        </div>
      </footer>
    </section>
  );
}
