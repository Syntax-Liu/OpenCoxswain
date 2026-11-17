import { useEffect, useMemo, useRef, useState } from 'react';
import { ListItem, TextInput } from '../ui/index.js';

/**
 * 命令面板（Ctrl+K）。
 *
 * 一个输入框搜一切：项目、会话、动作。
 *
 * ## 为什么要它
 *
 * 项目和会话多了之后，靠点侧栏找越来越慢。
 * 命令面板把「用鼠标找」变成「打字找」——这是 VS Code 和 DSH 都有、
 * 而我们之前完全没有的东西。
 *
 * ## 交互约定
 *
 * - 打开时自动聚焦输入框
 * - ↑↓ 选择，Enter 执行，Esc 关闭
 * - 输入即过滤（不区分大小写，匹配名称和说明）
 */

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** 分组标题：项目 / 动作 / 会话。 */
  readonly group: string;
  readonly run: () => void;
}

export interface CommandPaletteProps {
  readonly items: readonly PaletteItem[];
  readonly onClose: () => void;
  /**
   * 异步搜索会话内容。
   *
   * 和 items（本地的项目/动作）不同，这是要去运行时查的，
   * 所以单独一个回调，由面板自己管加载状态。
   */
  readonly onSearch?: (query: string) => Promise<readonly PaletteItem[]>;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时聚焦：不聚焦的话用户要先点一下才能打字
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 会话全文搜索：异步、防抖
  const [sessionHits, setSessionHits] = useState<readonly PaletteItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!props.onSearch || q.length < 2) {
      setSessionHits([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    // 防抖：连续打字不要每个字符都发请求
    const timer = setTimeout(() => {
      props
        .onSearch?.(q)
        .then((hits) => {
          if (!cancelled) setSessionHits(hits);
        })
        .catch(() => {
          if (!cancelled) setSessionHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [props.onSearch, query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // 本地项（项目/动作）先过滤；会话搜索结果是运行时给的，不再过滤
    const local = !q
      ? props.items
      : props.items.filter(
          (item) =>
            item.label.toLowerCase().includes(q) ||
            (item.hint ?? '').toLowerCase().includes(q) ||
            item.group.toLowerCase().includes(q),
        );
    return [...local, ...sessionHits];
  }, [props.items, query, sessionHits]);

  // 过滤结果变化时把选中项拉回 0，避免越界
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 选中项滚进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (item: PaletteItem | undefined): void => {
    if (!item) return;
    props.onClose();
    // 先关闭再执行：动作里可能要弹别的层，不能两个叠着
    item.run();
  };

  return (
    <div className="palette-overlay" onClick={props.onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="命令面板"
      >
        <TextInput ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="搜索项目、会话或动作…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runItem(filtered[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              props.onClose();
            }
          }} />

        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-empty">{searching ? '搜索会话中…' : '没有匹配的项'}</div>
          )}

          {filtered.map((item, index) => {
            // 分组标题：只在每一组的第一个之前显示
            const showGroup = index === 0 || filtered[index - 1]?.group !== item.group;
            return (
              <div key={item.id}>
                {showGroup && <div className="palette-group">{item.group}</div>}
                <ListItem data-index={index} onMouseEnter={() => setActive(index)} onClick={() => runItem(item)} variant={"palette-item"}><span className="palette-label">{item.label}</span>{item.hint && <span className="palette-hint">{item.hint}</span>}</ListItem>
              </div>
            );
          })}
        </div>

        <div className="palette-footer">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
