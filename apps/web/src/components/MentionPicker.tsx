/**
 * `@` 文件引用补全。
 *
 * 用户输入 `@` 后弹出文件列表，选中后插入 `@路径`。
 * 后端 `listFiles(projectId, q)` 支持按查询过滤，所以边打字边收窄。
 *
 * 设计取舍：
 * - **不做全量文件树**：只在输入 `@` 时按需查询，避免大仓库卡顿；
 * - 选中后插入的是**路径文本**而不是特殊标记：模型能直接读懂，
 *   不需要额外的协议，也不会让消息在历史里变成看不懂的结构。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntryDto } from '../api.js';
import { ApiClient } from '../api.js';

export interface MentionPickerProps {
  readonly projectId: string;
  /** 当前已输入的内容。 */
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement>;
}

/** 找出光标前最近的 `@` 片段；没有则返回 null。 */
export function activeMention(value: string, caret: number): { start: number; query: string } | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at < 0) return null;
  // `@` 前面必须是行首或空白，否则算普通字符（如邮箱）
  const before = at === 0 ? '' : upToCaret[at - 1];
  if (before && !/\s/.test(before)) return null;
  const query = upToCaret.slice(at + 1);
  // 片段里不能有空白或换行
  if (/[\s\n]/.test(query)) return null;
  return { start: at, query };
}

export function MentionPicker(props: MentionPickerProps): JSX.Element | null {
  const caret = useMemo(() => {
    const el = props.textareaRef.current;
    return el ? el.selectionStart : props.value.length;
  }, [props.value, props.textareaRef]);

  const mention = useMemo(() => activeMention(props.value, caret), [props.value, caret]);

  const [items, setItems] = useState<readonly FileEntryDto[]>([]);
  const [index, setIndex] = useState(0);
  const api = useMemo(() => new ApiClient(), []);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mention) {
      setItems([]);
      return;
    }
    // 防抖：边打字边查，150ms 足够
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void api
        .listFiles(props.projectId, mention.query)
        .then((r) => {
          setItems(r.files.slice(0, 8));
          setIndex(0);
        })
        .catch(() => setItems([]));
    }, 150);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [api, props.projectId, mention?.query]);

  if (!mention || items.length === 0) return null;

  const pick = (entry: FileEntryDto): void => {
    const before = props.value.slice(0, mention.start);
    const after = props.value.slice(mention.start + 1 + mention.query.length);
    props.onChange(`${before}@${entry.path}${after}`);
    // 光标放到插入内容之后
    requestAnimationFrame(() => {
      const el = props.textareaRef.current;
      if (!el) return;
      const pos = before.length + 1 + entry.path.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="mention" role="listbox" aria-label="引用文件">
      {items.map((f, i) => (
        <button
          key={f.path}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`mention-item${i === index ? ' active' : ''}`}
          onMouseEnter={() => setIndex(i)}
          onClick={() => pick(f)}
        >
          <span className="mention-path">{f.path}</span>
        </button>
      ))}
    </div>
  );
}
