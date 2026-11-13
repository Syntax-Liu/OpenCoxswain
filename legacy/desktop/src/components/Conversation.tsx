import { useEffect, useRef, useState } from 'react';
import {
  ACCEPTANCE_TYPE_LABELS,
  DELIVERABLE_TYPE_LABELS,
  type Message,
  type Project,
  type Task,
  type TaskTemplate,
} from '@opencoxswain/shared';
import type { TaskAction } from '../api.js';
import { formatTime, MarkdownLite } from '../ui.js';

interface Props {
  messages: Message[];
  root: Task | null;
  children: Task[];
  templates: TaskTemplate[];
  project: Project;
  busy: boolean;
  onPlan: (goal: string, acceptanceCommand?: string, templateId?: string) => Promise<boolean>;
  onAction: (action: TaskAction, note?: string) => void;
}

export function Conversation({
  messages,
  root,
  children,
  templates,
  project,
  busy,
  onPlan,
  onAction,
}: Props): JSX.Element {
  const [goal, setGoal] = useState('');
  const [command, setCommand] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, root?.status]);

  const active = root !== null && !['done', 'cancelled', 'failed'].includes(root.status);
  const awaitingApproval = root?.status === 'awaiting_approval';
  const template = templates.find((item) => item.id === templateId) ?? null;

  const pickTemplate = (id: string): void => {
    setTemplateId(id);
    const next = templates.find((item) => item.id === id);
    if (next) setGoal(next.goal);
  };

  const submit = async (): Promise<void> => {
    const finalGoal = goal.trim() || template?.goal || '';
    if (!finalGoal || busy || active) return;
    const ok = await onPlan(
      finalGoal,
      command.trim() || undefined,
      template?.id,
    );
    if (ok) {
      setGoal('');
      setCommand('');
      setTemplateId('');
    }
  };

  return (
    <section className="panel conversation">
      <div className="panel-body messages">
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <h2>要做什么？</h2>
            <p>说一句目标，总管先给任务单；你确认开工后员工才动手。</p>
          </div>
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
        {templates.length > 0 ? (
          <select
            className="composer-template"
            value={templateId}
            onChange={(event) => pickTemplate(event.target.value)}
            disabled={active}
            aria-label="任务模板"
          >
            <option value="">不用模板</option>
            {templates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        ) : null}
        {template ? (
          <div className="template-preview">
            <p className="hint">{template.summary}</p>
            <dl className="inline-facts">
              <div>
                <dt>默认交付物</dt>
                <dd>
                  {template.deliverables
                    .map((item) => DELIVERABLE_TYPE_LABELS[item.type])
                    .join('、')}
                </dd>
              </div>
              <div>
                <dt>验收方式</dt>
                <dd>
                  {template.acceptance
                    .map(
                      (item) => `${ACCEPTANCE_TYPE_LABELS[item.type]}：${item.desc}`,
                    )
                    .join('；')}
                </dd>
              </div>
              <div>
                <dt>默认写入范围</dt>
                <dd>{template.writeScope.join('、') || '只读，不写仓库'}</dd>
              </div>
              <div>
                <dt>一键合并</dt>
                <dd>
                  {template.allowAutoMerge
                    ? '允许（仍需低风险与二次确认）'
                    : '不允许'}
                </dd>
              </div>
              <div>
                <dt>项目授权</dt>
                <dd>
                  {project.allowNetwork ? '允许联网读取' : '禁止联网'} /{' '}
                  {project.allowExternalSend ? '允许外发（逐次审批）' : '禁止外发'}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
        <div className="composer-box">
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                void submit();
              }
            }}
            placeholder={
              active
                ? '当前有进行中的任务，完成或取消后再开始新目标'
                : template
                  ? '可修改模板预填的目标，再交给总管'
                  : '例如：修复夜间模式切换后不生效'
            }
            rows={3}
            disabled={active}
          />
          <div className="composer-bar">
            <input
              className="composer-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="验收命令（可选），例如 npm test"
              disabled={active}
            />
            <button
              className="primary"
              onClick={() => void submit()}
              disabled={busy || active || (!goal.trim() && !template)}
            >
              {busy ? '处理中…' : '发送'}
            </button>
          </div>
        </div>
      </footer>
    </section>
  );
}
