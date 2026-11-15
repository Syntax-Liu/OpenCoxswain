/**
 * 待拍板卡片。
 *
 * 之前的错误：只给一个「查看并处理」按钮，而它只是打开执行者详情页——
 * 详情页没有输入框，用户唯一的解法是退回对话页手动打一段话。
 * 这不是"拍板"，是"绕路"。
 *
 * 现在：卡片里直接能回答。回答通过 say() 发给 C（项目助理），
 * 由 C 决定怎么处理——这是架构允许的唯一正确通道
 * （接口层没有"直接给某个 D 传话"的入口）。
 */
import { useCallback, useRef, useState } from 'react';
import type { ExecutorDto } from '../api.js';

export interface DecisionCardProps {
  readonly executor: ExecutorDto;
  readonly onAnswer: (text: string) => void;
  readonly onSeeTrace: () => void;
}

export function DecisionCard(props: DecisionCardProps): JSX.Element {
  const { executor } = props;
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const v = text.trim();
    if (!v) return;
    props.onAnswer(v);
    setText('');
  }, [text, props]);

  return (
    <div className="decision">
      <span className="decision-from">{executor.label} 需要你确认</span>
      <p className="decision-q">{executor.blockedReason ?? '需要你决定'}</p>

      <textarea
        ref={ref}
        className="decision-input"
        rows={2}
        value={text}
        placeholder="直接回答它（Enter 发送，Shift+Enter 换行）"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="decision-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={submit}
          disabled={text.trim().length === 0}
        >
          发送
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={props.onSeeTrace}>
          看它做了什么
        </button>
      </div>
    </div>
  );
}
