import { useEffect, useMemo, useRef, useState } from 'react';

import type { ExecutorDto, MessageDto, ProjectDto } from '../api.js';
import { renderMarkdown } from './Markdown.js';
import { MessageActions } from './MessageActions.js';
import { useAutoScroll } from './useAutoScroll.js';
import { TraceView } from './TraceView.js';
import { BatchBlock } from './BatchBlock.js';
import { groupBatches, isNotableBatch, type Batch } from './batches.js';

export interface ConversationProps {
  readonly project: ProjectDto;
  readonly messages: readonly MessageDto[];
  readonly thinking: boolean;
  /** 记忆候选审阅区（可折叠），放在顶部。 */
  readonly memoryReview?: React.ReactNode;
  /** 模板选择器，放在输入框下方。 */
  readonly templatePicker?: React.ReactNode;
  /** 轨迹页用的完整消息（含内部通知）；不给就用 messages。 */
  readonly traceMessages?: readonly MessageDto[];
  /** 当前项目的 Agent 列表，用来画批次线。 */
  readonly executors?: readonly ExecutorDto[];
  /** 点批次里的某个 Agent → 打开它的对话。 */
  readonly onOpenExecutor?: (executorId: string) => void;
  /** 底部状态栏的汇总指标（照 DSH 的一行指标）。 */
  readonly stats?: {
    readonly turns: number;
    readonly steps: number;
    readonly tokensPerSecond: string;
    readonly totalTokens: string;
    readonly cacheHit: string;
  };
  /** 外部注入的草稿（模板填入用）；变化时覆盖输入框。 */
  readonly draftSeed?: { readonly text: string; readonly at: number };
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}

/**
 * 与Assistant 的对话。
 *
 * 这里**只显示人和 C 说的话**。Agent 的一切（结算通知、工具调用、
 * 原始产出）都不进来——它们在左侧导航里各自的对话中。
 *
 * 输入框**从不被禁用**：C 还在回复时用户依然可以继续发（连发不打断）。
 */
export function Conversation(props: ConversationProps): JSX.Element {
  const [draft, setDraft] = useState('');
  // 批次：同一轮派出的 Agent 归到一起（签名元素）
  const allBatches = useMemo(() => groupBatches(props.executors ?? []), [props.executors]);
  /** 当前标签页：对话 / 轨迹（照 DSH）。 */
  const [tab, setTab] = useState<'chat' | 'trace'>('chat');
  // 轨迹条数（标签上的小数字）
  const traceCount = (props.traceMessages ?? props.messages).filter((m) => !m.internal).length;

  // 模板填入：只在 seed 变化时覆盖一次，不干扰用户后续输入。
  const lastSeed = useRef<number>(0);
  useEffect(() => {
    if (!props.draftSeed || props.draftSeed.at === lastSeed.current) return;
    lastSeed.current = props.draftSeed.at;
    setDraft(props.draftSeed.text);
  }, [props.draftSeed]);

  const visible = props.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.internal,
  );

  const scroll = useAutoScroll(visible.length);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    props.onSend(text);
    setDraft('');
  };

  return (
    <div className="conversation">
      {/* 标题行照 DSH：标题 + 状态标签 + 右侧操作 */}
      <header className="conversation-header">
        <div className="header-main">
          <h2>{props.project.name}</h2>
          <span className="header-badge">Agent 模式</span>
        </div>
        <div className="header-side">
          <span className="muted small" title={props.project.displayPath}>
            {props.project.displayPath}
          </span>
        </div>
      </header>

      {/* 标签页：对话 / 轨迹（照 DSH） */}
      <div className="view-tabs" role="tablist">
        <button
          type="button"
          className={`view-tab${tab === 'chat' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'chat'}
          onClick={() => setTab('chat')}
        >
          对话
        </button>
        <button
          type="button"
          className={`view-tab${tab === 'trace' ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === 'trace'}
          onClick={() => setTab('trace')}
        >
          轨迹
          {traceCount > 0 && <span className="view-tab-count">{traceCount}</span>}
        </button>
        <span className="view-tab-more" aria-hidden>⋯</span>
      </div>

      {tab === 'trace' ? (
        <TraceView messages={props.traceMessages ?? props.messages} />
      ) : (
        <>
          {props.memoryReview}

          <div className="messages" ref={scroll.ref}>
        {visible.length === 0 && (
          <div className="hint-card">
            <p>直接说要做什么，我可以同时派多个 Agent：</p>
            <ul>
              <li>把登录页重构成组件</li>
              <li>查一下导出为什么卡住（只读排查）</li>
              <li>给这个功能补测试</li>
            </ul>
            <p className="muted small">可以连续发多条，不会打断我。</p>
          </div>
        )}

        {visible.map((message, index) => {
          const prev = visible[index - 1];
          const showTime = shouldShowTime(prev, message);
          // 这一条之后要插入的批次：按派出时间落在两条消息之间
          const here = batchesBetween(message, visible[index + 1], allBatches);
          return (
            <div key={message.id}>
              {showTime && <div className="time-divider">{formatTime(message.at)}</div>}
              <Message message={message} onResend={props.onSend} />
              {here.map((batch) => (
                <BatchBlock
                  key={batch.id}
                  batch={batch}
                  onOpen={(id) => props.onOpenExecutor?.(id)}
                />
              ))}
            </div>
          );
        })}

        {/* 最后一条之后可能还有批次（刚派出去、还没回复） */}
        {batchesBetween(visible[visible.length - 1], undefined, allBatches).map((batch) => (
          <BatchBlock
            key={batch.id}
            batch={batch}
            onOpen={(id) => props.onOpenExecutor?.(id)}
          />
        ))}

        {props.thinking && (
          <div className="message assistant">
            <span className="msg-role">Assistant</span>
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

      {!scroll.atBottom && (
        <button type="button" className="jump-bottom" onClick={scroll.scrollToBottom}>
          {scroll.unread > 0 ? `${scroll.unread} 条新消息` : '回到底部'}
          <span aria-hidden> ↓</span>
        </button>
      )}

      {/* 输入区照 DSH：浮在底部的大框，内含工具栏 + 圆形发送 */}
      <div className="composer">
        <div className="composer-box">
          <textarea
            value={draft}
            placeholder="发消息或创建任务，/ 调用指令，@ 文件或对话"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
          />
          <div className="composer-bar">
            <div className="composer-left">
              {props.templatePicker}
              <button
                type="button"
                className="composer-chip"
                onClick={props.onStop}
                title="停止当前这轮"
              >
                停止
              </button>
            </div>
            <button
              type="button"
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
              aria-label="发送"
              title="发送（Enter）"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
        </>
      )}

      {/* 底部状态栏照 DSH：一行汇总当前项目的运行指标 */}
      <footer className="status-bar">
        <span className="status-item">
          <span className="status-icon" aria-hidden>⟳</span>
          {props.stats?.turns ?? 0} 轮 · {props.stats?.steps ?? 0} 步
        </span>
        <span className="status-item">
          <span className="status-icon" aria-hidden>⚡</span>
          {props.stats?.tokensPerSecond ?? '—'} tok/s
        </span>
        <span className="status-item">
          <span className="status-icon" aria-hidden>Σ</span>
          {props.stats?.totalTokens ?? '—'} tok
        </span>
        <span className="status-item">
          <span className="status-icon" aria-hidden>⚡</span>
          缓存命中 {props.stats?.cacheHit ?? '—'}
        </span>
      </footer>
    </div>
  );
}

function Message({
  message,
  onResend,
}: {
  message: MessageDto;
  onResend?: (text: string) => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      {/* 角色标签取代头像：桌面软件不用圆形头像，用一行小字 */}
      <span className="msg-role">{isUser ? '你' : 'Assistant'}</span>
      <div className="bubble">
        {renderMarkdown(message.content)}
        <div className="bubble-footer">
          <MessageActions
            content={message.content}
            {...(isUser && onResend ? { onResend: () => onResend(message.content) } : {})}
          />
        </div>
      </div>
    </div>
  );
}

/** 隔 5 分钟才显示一次时间，避免每条都顶一行。 */
function shouldShowTime(prev: MessageDto | undefined, current: MessageDto): boolean {
  if (!prev) return true;
  return current.at - prev.at > 5 * 60_000;
}

/**
 * 找出落在两条消息之间的批次。
 *
 * 批次代表「这一轮派出去的 Agent」，时间点是第一个 Agent 的创建时间。
 * 落在 `(after.at, before.at]` 区间内就显示在这里。
 * **单条 Agent 的批次不画**——那是普通派活，不需要强调「批」。
 */
function batchesBetween(
  after: MessageDto | undefined,
  before: MessageDto | undefined,
  allBatches: readonly Batch[],
): readonly Batch[] {
  if (!after) return [];
  const end = before?.at ?? Number.POSITIVE_INFINITY;
  return allBatches.filter((b) => isNotableBatch(b) && b.at > after.at && b.at <= end);
}

function formatTime(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}
