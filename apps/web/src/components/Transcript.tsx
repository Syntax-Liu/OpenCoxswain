/**
 * 对话流。
 *
 * 阅读优先：
 * - 正文行高 1.65，单行不超过 75 字符（CSS 里 max-width: 75ch）
 * - 用户消息带淡背景块，助手消息无框（减少视觉噪音）
 * - 系统提示居中低对比
 *
 * 不做的：气泡右对齐。长文右对齐会让眼动距离忽大忽小，读起来累。
 */
import { useEffect, useRef } from 'react';
import type { MessageDto, SideEffectDto } from '../api.js';
import { renderMarkdown } from './Markdown.js';
import { MessageActions } from './MessageActions.js';
import { FileCard } from './FileCard.js';

export interface TranscriptProps {
  readonly messages: readonly MessageDto[];
  /** 对 Assistant 消息重试：再发一次同样的请求。 */
  readonly onRetry?: (message: MessageDto) => void;
  /** 编辑用户消息后重发。 */
  readonly onEditResend?: (message: MessageDto, next: string) => void;
  /** 文件变更：跟在对话流里，轻量呈现，不另开窗口。 */
  readonly fileChanges?: readonly SideEffectDto[];
  /** 点预览 → 侧边栏打开。 */
  readonly onPreviewFile?: (path: string) => void;
}

/** 系统内部通知不显示在对话流里（它是给模型的指令）。 */
function visible(m: MessageDto): boolean {
  if (!m.content?.trim()) return false;
  if (m.role === 'tool') return false;
  return true;
}

export function Transcript(props: TranscriptProps): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 只有用户已经在底部时才自动跟随——否则打断向上翻阅
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickRef.current = gap < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const shown = props.messages.filter(visible);

  /**
   * 文件变更卡片：只保留最近 8 条**文件类**副作用。
   *
   * 注意顺序：**先过滤再截取**。台账里绝大多数是 proc.exec（跑命令），
   * 如果先 slice 再过滤，会被命令记录占满位置，真正的文件写入反而显示不出来。
   */
  const fileCards = (props.fileChanges ?? [])
    .filter((e) => e.kind === 'fs.write' || e.kind === 'fs.delete')
    .filter((e) => e.state === 'succeeded' || e.state === 'failed')
    .slice(-8);

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  return (
    <div className="transcript" ref={scrollerRef}>
      {shown.length === 0 ? (
        <div className="empty">
          <h2 className="empty-title">这个项目还没有对话</h2>
          <p className="empty-hint">
            直接说你要做什么。它会自己判断要不要派 Agent、派几个。
          </p>
        </div>
      ) : (
        <div className="transcript-inner">
          {shown.map((m) => (
            <Message
              key={m.id}
              message={m}
              onRetry={props.onRetry}
              onEditResend={props.onEditResend}
            />
          ))}
          {/* 文件变更：跟在对话末尾，轻量卡片，不打断阅读。
              只显示最近 8 条——更早的去轨迹页看，避免刷屏。 */}
          {fileCards.length > 0 && (
            <div className="file-cards">
              {fileCards.map((e) => (
                <FileCard
                  key={e.id}
                  effect={e}
                  onPreview={(path) => props.onPreviewFile?.(path)}
                />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}

function Message(props: {
  readonly message: MessageDto;
  readonly onRetry?: (message: MessageDto) => void;
  readonly onEditResend?: (message: MessageDto, next: string) => void;
}): JSX.Element {
  const m = props.message;
  const role = m.role === 'user' ? 'user' : 'assistant';

  return (
    <div className={`msg ${role}`}>
      <span className="msg-who">{role === 'user' ? '你' : 'Assistant'}</span>
      <div className="msg-body">
        {role === 'assistant' ? renderMarkdown(m.content) : m.content}
      </div>
      <MessageActions
        role={m.role}
        source={m.source}
        content={m.content}
        {...(role === 'assistant' && props.onRetry
          ? { onRetry: () => props.onRetry?.(m) }
          : {})}
        {...(role === 'user' && props.onEditResend
          ? { onEdit: (next: string) => props.onEditResend?.(m, next) }
          : {})}
      />
    </div>
  );
}
