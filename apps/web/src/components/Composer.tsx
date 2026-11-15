/**
 * 输入框。
 *
 * 设计要点：
 * - **唯一的派活入口**。不做"新建任务"按钮——用户不该区分"聊天"和"派活"。
 * - Enter 发送，Shift+Enter 换行。
 * - `@` 引用文件、粘贴/拖入图片（这两种是"指认上下文"的基本能力）。
 * - 发送后立即清空并重新聚焦，不阻塞。
 */
import { useCallback, useRef, useState } from 'react';
import { MentionPicker } from './MentionPicker.js';

export interface ComposerProps {
  readonly onSend: (text: string, images: readonly ComposerImage[]) => void;
  /**
   * 停止一切。**不传就不显示停止按钮**——
   * 没有在跑的东西时，一个点了没反应的按钮比没有按钮更糟。
   */
  readonly onStop?: () => void;
  /** 当前在跑的 Agent 数量，用来把停止按钮说清楚。 */
  readonly runningCount?: number;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** 没有项目时禁用 @ 补全。 */
  readonly projectId?: string | null;
}

export interface ComposerImage {
  readonly type: 'image';
  readonly dataUrl: string;
  readonly name: string;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function Composer(props: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const [images, setImages] = useState<readonly ComposerImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  /** 跟随内容长高，到上限后内部滚动。 */
  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);

  const addFiles = useCallback(async (files: readonly File[]) => {
    const next: ComposerImage[] = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        setError(`图片 ${f.name} 超过 4MB，没有添加`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(f);
      }).catch(() => null);
      if (dataUrl) next.push({ type: 'image', dataUrl, name: f.name });
    }
    if (next.length > 0) {
      setImages((prev) => [...prev, ...next]);
      setError(null);
    }
  }, []);

  const submit = useCallback(() => {
    const value = text.trim();
    if ((!value && images.length === 0) || props.disabled) return;
    props.onSend(value, images);
    setText('');
    setImages([]);
    setError(null);
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.focus();
    }
  }, [text, images, props]);

  return (
    <div className="composer-wrap">
      {props.projectId && (
        <MentionPicker
          projectId={props.projectId}
          value={text}
          onChange={(next) => {
            setText(next);
            autoGrow();
          }}
          textareaRef={ref}
        />
      )}

      <div
        className={`composer${dragOver ? ' drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles([...e.dataTransfer.files]);
        }}
      >
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((img, i) => (
              <div className="composer-image" key={`${img.name}-${i}`}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="composer-image-remove"
                  title="移除"
                  onClick={() => setImages((prev) => prev.filter((_, k) => k !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={
            props.placeholder ?? '说点什么，或直接说要做什么（@ 引用文件，可拖入图片）'
          }
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />

        {error && <p className="composer-error">{error}</p>}

        <div className="composer-bar">
          {/* 停止按钮：只有真的在跑才出现，并且说清楚在停什么 */}
          {props.onStop && (props.runningCount ?? 0) > 0 && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={props.onStop}
              title="停止当前项目中所有正在执行的 Agent"
            >
              停止 {props.runningCount} 个
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn btn--primary btn--md"
            onClick={submit}
            disabled={props.disabled || (text.trim().length === 0 && images.length === 0)}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
