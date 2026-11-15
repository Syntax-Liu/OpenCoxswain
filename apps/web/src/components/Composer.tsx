/**
 * 输入框。
 *
 * 设计要点：
 * - **唯一的派活入口**。不做"新建任务"按钮——用户不该区分"聊天"和"派活"。
 * - Enter 发送，Shift+Enter 换行。
 * - 发送后立即清空并失焦保护，不阻塞。
 */
import { useCallback, useRef, useState } from 'react';

export interface ComposerProps {
  readonly onSend: (text: string) => void;
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
          <span className="spacer" />
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
