import { useEffect, useRef, useState } from 'react';

import type { ExecutorDto, MessageDto } from '../api.js';
import { EXECUTOR_STATUS_LABEL } from '../state.js';
import { cacheHitRate, formatDuration, formatPercent, formatRate, formatTokens, summarize } from '../metrics.js';
import { renderMarkdown } from './Markdown.js';

export interface ExecutorChatProps {
  readonly executor: ExecutorDto;
  readonly messages: readonly MessageDto[];
  readonly loading: boolean;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  readonly onBack: () => void;
}

/**
 * 一个执行者 D 的对话视图。
 *
 * 结构对齐主流 Agent 软件：这里就是"打开原会话"。
 * - 首条是它的任务目标；
 * - 中间是每一步工具调用与结果的轨迹；
 * - 末尾是它的结论；
 * - 用户可以在下面继续追问（**带原上下文**续跑）。
 */
export function ExecutorChat(props: ExecutorChatProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = props.executor.status === 'running' || props.executor.status === 'starting';

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, busy]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    props.onSend(text);
    setDraft('');
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <button type="button" className="ghost back-btn" onClick={props.onBack}>
          ← 返回
        </button>
        <div className="header-main">
          <h2>{props.executor.label}</h2>
          <p className="muted small">
            {props.executor.access === 'readonly' ? '只读执行者' : '执行者'} ·{' '}
            {EXECUTOR_STATUS_LABEL[props.executor.status]}
          </p>
        </div>
        {busy && (
          <button type="button" className="ghost" onClick={props.onCancel}>
            取消
          </button>
        )}
      </header>

      <div className="messages" ref={scrollRef}>
        <section className="goal-card">
          <p className="muted small">任务目标</p>
          <div className="md-body">{renderMarkdown(props.executor.goal)}</div>
          {props.executor.blockedReason && (
            <div className="blocked md-body">{renderMarkdown(props.executor.blockedReason)}</div>
          )}
        </section>

        {props.loading && <p className="muted small">正在读取执行记录…</p>}

        {props.messages.map((message) => (
          <TranscriptItem key={message.id} message={message} />
        ))}

        {busy && (
          <div className="message assistant">
            <span className="avatar">D</span>
            <div className="bubble">
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder={busy ? '执行者还在跑，等它结束再追问…' : '继续追问这个执行者（它会带着原有上下文继续）'}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
        <div className="composer-actions">
          <MetricsLine executor={props.executor} />
          <button type="button" className="primary" onClick={submit} disabled={busy || !draft.trim()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 运行指标行。
 *
 * 仿 DeepSeek Harness 的底部状态条：轮次、步数、吞吐、总量、缓存、上下文。
 * **不做计费**——不同模型单价不同且随时调整，估出来的金额只会误导人。
 */
export function MetricsLine({ executor }: { executor: ExecutorDto }): JSX.Element | null {
  const m = executor.metrics;
  if (!m || (m.turns === 0 && m.tokensIn === 0)) return null;

  const hit = cacheHitRate(m);
  const items: string[] = [];
  if (m.turns > 0) items.push(`${m.turns} 轮`);
  if (m.steps > 0) items.push(`${m.steps} 步`);
  if (m.tokensOut > 0 && m.durationMs > 0) items.push(formatRate(m.tokensOut, m.durationMs));
  items.push(`${formatTokens(m.tokensIn + m.tokensOut)} tok`);
  if (m.durationMs > 0) items.push(formatDuration(m.durationMs));
  if (hit !== null) items.push(`缓存 ${formatPercent(hit)}`);
  if (m.contextTokens !== null) items.push(`上下文 ${formatTokens(m.contextTokens)}`);

  return (
    <span className="metrics-line" title="运行指标（不估算金额：单价随模型变动，请以服务商后台为准）">
      {items.join(' · ')}
    </span>
  );
}

/**
 * 一条轨迹记录。
 *
 * 工具调用与工具结果是**执行过程**，用紧凑样式显示，不要和对话抢视觉。
 */
function TranscriptItem({ message }: { message: MessageDto }): JSX.Element | null {
  // 首条目标已经在顶部目标卡片里显示过，跳过。
  if (message.source === 'assistant' && message.role === 'user') return null;

  if (message.source === 'tool') {
    return (
      <div className="tool-row">
        <span className="tool-badge">调用</span>
        <code>{message.content}</code>
      </div>
    );
  }

  if (message.source === 'tool-result') {
    const failed = message.content.startsWith('（失败）');
    return (
      <div className={`tool-row result${failed ? ' failed' : ''}`}>
        <span className="tool-badge">结果</span>
        <span className="tool-output">{message.content.replace(/^（失败）/, '')}</span>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="bubble">{renderMarkdown(message.content)}</div>
      </div>
    );
  }

  return (
    <div className="message assistant">
      <span className="avatar">D</span>
      <div className="bubble">{renderMarkdown(message.content)}</div>
    </div>
  );
}
