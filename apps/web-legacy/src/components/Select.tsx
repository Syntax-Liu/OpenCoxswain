/**
 * 统一的下拉选择器。
 *
 * ## 用户反馈
 *
 * > 还有截图这种UI，为什么就不能统一呢？这个白块是什么鬼？
 * > 你把所有控件整合到一起，把作用相似的控件设计整合，
 * > 而不是开一堆风格不统一的UI
 *
 * 截图里那三个白块是**浏览器原生的 `<select>`**——它的弹出层、箭头、
 * 高亮色全由操作系统决定，和深色界面完全割裂，任何 CSS 都改不动
 * 下拉列表本身。
 *
 * ## 做法
 *
 * 自己画一个：按钮 + 浮层列表，和项目选择器、权限选择器、
 * 右栏的折叠头**共用同一套视觉语言**（同样的圆角、边框、悬停色）。
 *
 * 键盘可用：Up/Down 移动、Enter 选中、Esc 关闭、Tab 离开即关。
 */
import { useEffect, useRef, useState } from 'react';

import { IconCheck, IconChevron } from './icons.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  /** 可选的补充说明（显示在选项下方）。 */
  readonly hint?: string;
}

export interface SelectProps {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

export function Select(props: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const current = props.options.find((o) => o.value === props.value);

  // 点外面关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 打开时把当前项设为活动项
  useEffect(() => {
    if (!open) return;
    const idx = props.options.findIndex((o) => o.value === props.value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, props.value, props.options]);

  // 活动项滚进可视区
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const list = listRef.current;
    const item = list?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const choose = (value: string): void => {
    props.onChange(value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (props.disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, props.options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const opt = props.options[activeIndex];
      if (opt) choose(opt.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="ui-select" ref={rootRef}>
      <button
        type="button"
        className={`btn btn--secondary btn--md ui-select-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        disabled={props.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(props.ariaLabel ? { 'aria-label': props.ariaLabel } : {})}
      >
        <span className={`ui-select-value${current ? '' : ' placeholder'}`}>
          {current?.label ?? props.placeholder ?? '请选择'}
        </span>
        <IconChevron size={12} direction={open ? 'down' : 'right'} />
      </button>

      {open && (
        <ul className="ui-select-menu" role="listbox" ref={listRef}>
          {props.options.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === props.value}
                className={`ui-select-item${o.value === props.value ? ' active' : ''}${
                  i === activeIndex ? ' focused' : ''
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(o.value)}
              >
                <span className="ui-select-check">
                  {o.value === props.value && <IconCheck size={14} />}
                </span>
                <span className="ui-select-item-body">
                  <span className="ui-select-item-label">{o.label}</span>
                  {o.hint && <span className="ui-select-item-hint">{o.hint}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
