/**
 * 输入框。
 *
 * 设计要点：
 * - **唯一的派活入口**。不做"新建任务"按钮——用户不该区分"聊天"和"派活"。
 * - Enter 发送，Shift+Enter 换行。
 * - 发送后立即清空并失焦保护，不阻塞。
 *
 * ## 关于"停止"
 *
 * 产品上是**故意**不让用户打断 Assistant 的：发新消息就是排队，当前这轮跑完才被看到。
 * 唯一的例外是用户真的要收手——那时候停的不是 Assistant，而是**这一切**：
 * Assistant 这一轮 + 它派出去的所有 Agent。文案必须这么说清楚，
 * 否则用户会以为"停止"只是让 Assistant 别说话，而 Agent 还在改文件。
 */
import { useCallback, useRef, useState } from 'react';

export interface ComposerProps {
  readonly onSend: (text: string) => void;
  /**
   * 停止一切。**不传就不显示停止按钮**——
   * 没有在跑的东西时，一个点了没反应的按钮比没有按钮更糟。
   */
  readonly onStop?: () => void;
  /** 当前在跑的 Agent 数量，用来把停止按钮说清楚。 */
  readonly runningCount?: number;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export function Composer(props: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  /** 跟随内容长高，到上限后内部滚动。 */
  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || props.disabled) return;
    props.onSend(value);
    setText('');
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.focus();
    }
  }, [text, props]);

  const running = props.runningCount ?? 0;
  const showStop = props.onStop !== undefined && running > 0;

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={props.placeholder ?? '说点什么，或直接说要做什么（Enter 发送，Shift+Enter 换行）'}
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          {/* 在跑的时候告诉用户"说话不会打断它"——这是设计，不是没反应 */}
          {running > 0 && (
            <span className="composer-hint">
              {running} 个 Agent 在跑 · 直接说新的想法，它们不会被这句话打断
            </span>
          )}
          <span className="spacer" />
          {showStop && (
            <button
              type="button"
              className="btn btn--ghost btn--md"
              onClick={props.onStop}
              title={`停下 Assistant 这一轮，并取消正在跑和排队的 ${running} 个 Agent`}
            >
              停止全部
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--md"
            onClick={submit}
            disabled={props.disabled || text.trim().length === 0}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
