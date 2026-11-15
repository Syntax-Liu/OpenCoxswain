/**
 * 项目切换（头部下拉）。
 *
 * 为什么不做左栏常驻列表：
 * 大多数时间你只在一个项目里，左侧列一个数百像素的列表是浪费。
 * 需要快速跳转时：Ctrl+K 命令面板，或点这里。
 *
 * 旧界面的问题：项目名在头部和左栏各出现一次，视觉上非常吵。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDto } from '../api.js';

export interface ProjectSwitcherProps {
  readonly projects: readonly ProjectDto[];
  readonly current: ProjectDto | null;
  readonly onPick: (id: string) => void;
}

export function ProjectSwitcher(props: ProjectSwitcherProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const label = props.current?.name ?? '选择项目';
  // 项目名与产品名相同时不重复显示——旧界面踩过：
  // 首屏标题栏出现两个一模一样的 "OpenCoxswain"。
  const BRAND = 'OpenCoxswain';
  const showsBrand = label === BRAND;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className="head-project"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换项目"
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="项目"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 'var(--g-1)',
            minWidth: '240px',
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--r-md)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            padding: 'var(--g-1)',
            zIndex: 20,
          }}
        >
          {props.projects.length === 0 && (
            <p
              style={{
                margin: 0,
                padding: 'var(--g-3)',
                fontSize: 'var(--fs-sm)',
                color: 'var(--text-tertiary)',
              }}
            >
              还没有项目
            </p>
          )}
          {props.projects.map((p) => {
            const active = p.id === props.current?.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={active}
                className="btn btn--ghost btn--md"
                onClick={() => {
                  props.onPick(p.id);
                  close();
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: '1px',
                  width: '100%',
                  height: 'auto',
                  padding: 'var(--g-2) var(--g-3)',
                  background: active ? 'var(--surface-selected)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 'var(--fs-md)' }}>{p.name}</span>
                <span
                  style={{
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.rootPath}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
