import { useEffect, useMemo, useRef, useState } from 'react';

import type { ApiClient } from '../api.js';
import type { FileEntryDto } from '../api.js';

/**
 * @ 引用文件的选择器。
 *
 * ## 交互
 *
 * 在输入框里打 `@` 时弹出，继续打字就过滤。
 * `↑↓` 选择，`Enter`/`Tab` 确认，`Esc` 关闭。
 *
 * ## 为什么不用完整文件树
 *
 * 文件多的项目逐层点开很慢。真正好用的是**输入即过滤**：
 * 打 `@log` 直接出 `login.ts`。
 */
export interface MentionPickerProps {
  readonly api: ApiClient;
  readonly projectId: string;
  /** 已经输入的部分（@ 之后的内容）。 */
  readonly query: string;
  readonly onPick: (file: FileEntryDto) => void;
  readonly onClose: () => void;
}

export function MentionPicker(props: MentionPickerProps): JSX.Element {
  const [files, setFiles] = useState<FileEntryDto[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // 查询变化时重新取（运行时那边做了过滤和排序）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // 防抖：连续打字时不要每个字符都发一次请求
    const timer = setTimeout(() => {
      props.api
        .listFiles(props.projectId, props.query)
        .then((res) => {
          if (cancelled) return;
          setFiles(res.files);
          setActive(0);
        })
        .catch(() => {
          if (!cancelled) setFiles([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.api, props.projectId, props.query]);

  // 选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const shown = useMemo(() => files.slice(0, 12), [files]);

  return (
    <div className="mention-picker" ref={listRef}>
      {loading && shown.length === 0 && <div className="mention-empty">搜索中…</div>}
      {!loading && shown.length === 0 && <div className="mention-empty">没有匹配的文件</div>}

      {shown.map((file, index) => (
        <button
          key={file.path}
          type="button"
          data-index={index}
          className={`mention-item${index === active ? ' active' : ''}`}
          onMouseEnter={() => setActive(index)}
          // 用 onMouseDown 而不是 onClick：click 会先让输入框失焦，
          // 焦点一丢选择器就可能被关掉，点击就失效了。
          onMouseDown={(e) => {
            e.preventDefault();
            props.onPick(file);
          }}
        >
          <span className="mention-name">{file.name}</span>
          <span className="mention-path">{file.path}</span>
        </button>
      ))}
    </div>
  );
}

// 检测与替换逻辑在 mention.ts（纯函数，单独测试）
export { applyMention, detectMention, type MentionState } from './mention.js';
