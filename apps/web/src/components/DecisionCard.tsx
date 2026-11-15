/**
 * 待拍板卡片。
 *
 * 之前的错误：只给一个「查看并处理」按钮，而它只是打开 Agent详情页——
 * 详情页没有输入框，用户唯一的解法是退回对话页手动打一段话。
 * 这不是"拍板"，是"绕路"。
 *
 * 现在：卡片里直接能回答。回答通过 say() 发给 Assistant，
 * 由 C 决定怎么处理——这是架构允许的唯一正确通道
 * （接口层没有"直接给某个 D 传话"的入口）。
 */
import { useCallback, useRef, useState } from 'react';
import type { ReportDto } from '../api.js';

export interface DecisionCardProps {
  readonly report: ReportDto;
  readonly executorLabel: string;
  /**
   * 用户回答了。实现方必须做两件事：
   *   1. 把答案经 Assistant 转达（say）
   *   2. **ack 这条报告**——否则 needsUser 永远是 true，卡片永远不消失
   */
  readonly onAnswer: (text: string) => void;
  readonly onSeeTrace: () => void;
  /** 直接忽略这条，不再追问。 */
  readonly onDismiss: () => void;
}

export function DecisionCard(props: DecisionCardProps): JSX.Element {
  const { report, executorLabel } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    props.onAnswer(v);
    setText('');
    setBusy(false);
  }, [text, busy, props]);

  return (
    <div className="decision">
      <span className="decision-from">{executorLabel} 需要你确认</span>
      <p className="decision-q">{report.body}</p>

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
          disabled={text.trim().length === 0 || busy}
        >
          发送
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={props.onSeeTrace}>
          看它做了什么
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={props.onDismiss}
          title="不再追问这条"
        >
          忽略
        </button>
      </div>
    </div>
  );
}
