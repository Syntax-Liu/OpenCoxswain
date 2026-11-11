import { useEffect, useRef, useState } from 'react';

import type { MessageDto, ProjectDto } from '../api.js';
import { renderMarkdown } from './Markdown.js';

export interface ConversationProps {
  readonly project: ProjectDto;
  readonly messages: readonly MessageDto[];
  readonly thinking: boolean;
  /** 记忆候选审阅区（可折叠），放在顶部。 */
  readonly memoryReview?: React.ReactNode;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
}

/**
 * 与项目助理 C 的对话。
 *
 * 这里**只显示人和 C 说的话**。执行者的一切（结算通知、工具调用、
 * 原始产出）都不进来——它们在左侧导航里各自的对话中。
 *
 * 输入框**从不被禁用**：C 还在回复时用户依然可以继续发（连发不打断）。
 */
export function Conversation(props: ConversationProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = props.messages.filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.internal,
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, props.thinking]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    props.onSend(text);
    setDraft('');
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <div className="header-main">
          <h2>{props.project.name}</h2>
          <p className="muted small" title={props.project.displayPath}>
            项目助理 · C　{props.project.displayPath}
          </p>
        </div>
      </header>

      {props.memoryReview}

      <div className="messages" ref={scrollRef}>
        {visible.length === 0 && (
          <div className="hint-card">
            <p>直接说要做什么，我可以同时派多个执行者：</p>
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
          return (
            <div key={message.id}>
              {showTime && <div className="time-divider">{formatTime(message.at)}</div>}
              <Message message={message} />
            </div>
          );
        })}

        {props.thinking && (
          <div className="message assistant">
            <span className="avatar">C</span>
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
          placeholder="对项目助理说点什么…（Enter 发送，Shift+Enter 换行）"
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
          <button type="button" className="ghost" onClick={props.onStop} title="停止当前这轮">
            停止
          </button>
          <button type="button" className="primary" onClick={submit} disabled={!draft.trim()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ message }: { message: MessageDto }): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser && <span className="avatar">C</span>}
      <div className="bubble">{renderMarkdown(message.content)}</div>
    </div>
  );
}

/** 隔 5 分钟才显示一次时间，避免每条都顶一行。 */
function shouldShowTime(prev: MessageDto | undefined, current: MessageDto): boolean {
  if (!prev) return true;
  return current.at - prev.at > 5 * 60_000;
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
