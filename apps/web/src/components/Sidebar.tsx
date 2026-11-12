import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExecutorDto, ProjectDto } from '../api.js';
import { isFiltering, isRunning, matchExecutor, matchesProject } from './matching.js';
import { EXECUTOR_STATUS_LABEL } from '../state.js';
import { summarize } from '../metrics.js';
import {
  clampSidebarWidth,
  readSavedSidebarWidth,
  saveSidebarWidth,
} from '../sidebarWidth.js';

export interface SidebarProps {
  readonly projects: readonly ProjectDto[];
  readonly executors: readonly ExecutorDto[];
  readonly currentProjectId: string | null;
  readonly view:
    | { readonly kind: 'assistant'; readonly projectId: string }
    | { readonly kind: 'executor'; readonly projectId: string; readonly executorId: string }
    | { readonly kind: 'global' };
  readonly connected: boolean;
  readonly connectionDetail: string | null;
  readonly onOpenAssistant: (projectId: string) => void;
  readonly onOpenExecutor: (projectId: string, executorId: string) => void;
  readonly onOpenGlobal: () => void;
  readonly onOpenProject: () => void;
  readonly onOpenSettings: () => void;
  /**
   * 宽度变化回调。
   *
   * 为什么要把宽度上报给父组件：外层的 `.app-shell` 是 grid，
   * 网格列宽写死在 CSS 里。侧栏自己改 width 时网格列不跟，
   * 拖动看起来毫无反应。所以由父组件把列宽也一起改。
   */
  readonly onWidthChange?: (width: number) => void;
}

/**
 * 侧栏宽度与持久化统一放在 `sidebarWidth.ts`。
 *
 * 早期这里自己定义了一套常量并读 localStorage，而 App 那边写死 244，
 * 两边初始值不一致 → 重启后侧栏被网格列压住，拖一下才恢复。
 */

/**
 * 左侧导航。布局照 DeepSeek Harness，视觉照 VS Code：
 *
 * ```
 * [◎ 新会话]            ← 顶部大按钮（DSH）
 * 插件 / 自动化任务 / 更多  ← 图标 + 文字的功能项
 * ──────────────
 * 工作区          ⌕ ⇅ ＋   ← 标题行带小图标（DSH）
 *  ▾ 项目名                ← 点击 = 进 Assistant
 *     对话标题      已完成   ← 点击 = 看某个 Agent（右对齐状态）
 * ```
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [onlyRunning, setOnlyRunning] = useState(false);
  /** 搜索框是否展开。收起时只显示一个放大镜（照 DSH）。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // 展开后自动聚焦，用户不用再点一下
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  const [width, setWidth] = useState(readSavedSidebarWidth);
  const dragging = useRef(false);
  const widthRef = useRef(width);

  const filtering = isFiltering(query, onlyRunning);

  // 拖拽调整宽度。
  //
  // 两个坑（都是真踩过的）：
  // 1. 外层 `.app-shell` 是 grid，列宽写死 244px，光改侧栏宽度网格列不跟，
  //    看上去"拖了没反应"。CSS 里已改成 auto。
  // 2. 监听必须挂在 document 上，挂 window 时鼠标快速移出窗口会丢事件。
  const onMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragging.current = true;
    const startX = event.clientX;
    const startWidth = widthRef.current;
    document.body.classList.add('is-resizing');

    const onMove = (e: MouseEvent): void => {
      const next = clampSidebarWidth(startWidth + (e.clientX - startX));
      widthRef.current = next;
      setWidth(next);
      props.onWidthChange?.(next);
    };
    const onUp = (): void => {
      dragging.current = false;
      document.body.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try {
        saveSidebarWidth(widthRef.current);
      } catch {
        /* 存不了就算了 */
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);


  return (
    <aside className="sidebar" style={{ width }}>
      {/* 顶部：新会话（DSH 的大按钮） */}
      <div className="sidebar-top">
        <button type="button" className="new-session" onClick={props.onOpenProject}>
          <span aria-hidden>⊕</span> 新会话
        </button>
      </div>

      <nav className="nav-main">
        <button
          type="button"
          className={`nav-item${props.view.kind === 'global' ? ' active' : ''}`}
          onClick={props.onOpenGlobal}
        >
          <span className="nav-icon" aria-hidden>◎</span>
          Supervisor
        </button>
        <button type="button" className="nav-item" onClick={props.onOpenProject}>
          <span className="nav-icon" aria-hidden>⊞</span>
          添加项目
        </button>
      </nav>

      {/* 工作区标题行。
          搜索是**收起态**：默认一个放大镜，点开才展开成输入框（照 DSH）。 */}
      <div className={`workspace-head${searchOpen ? ' searching' : ''}`}>
        {searchOpen ? (
          <span className="search-box">
            <svg className="search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              className="search-input"
              value={query}
              placeholder="搜索会话名称"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  setSearchOpen(false);
                }
              }}
              aria-label="搜索会话名称"
            />
            <button
              type="button"
              className="search-clear"
              title="关闭搜索"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        ) : (
          <>
            <span className="workspace-title">工作区</span>
            <span className="workspace-actions">
              <button
                type="button"
                className="icon-btn"
                title="搜索"
                onClick={() => setSearchOpen(true)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`icon-btn${onlyRunning ? ' active' : ''}`}
                title={onlyRunning ? '显示全部' : '只看在跑'}
                aria-pressed={onlyRunning}
                onClick={() => setOnlyRunning((v) => !v)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M4.5 2.5v11M4.5 13.5 2 11M4.5 13.5 7 11M11.5 13.5v-11M11.5 2.5 9 5M11.5 2.5 14 5"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
          <button type="button" className="icon-btn" title="新建项目" onClick={props.onOpenProject}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
          </button>
            </span>
          </>
        )}
      </div>

      <div className="workspace-tree">
        {props.projects.length === 0 && (
          <p className="empty-hint muted small">还没有项目。点「新会话」添加一个。</p>
        )}

        {props.projects.map((project) => {
          const projectMatches = matchesProject(project, query, onlyRunning);          const items = props.executors.filter(
            (e) => e.projectId === project.id && matchExecutor(e, query, onlyRunning),
          );
          if (filtering && !projectMatches && items.length === 0) return null;

          const active =
            (props.view.kind === 'assistant' && props.view.projectId === project.id) ||
            (props.view.kind === 'executor' && props.view.projectId === project.id);

          return (
            <div className="project-group" key={project.id}>
              <button
                type="button"
                className={`project-folder${active ? ' active' : ''}`}
                onClick={() => props.onOpenAssistant(project.id)}
                title={project.displayPath}
              >
                <span className="folder-icon" aria-hidden>▾</span>
                <span className="folder-name">{project.name}</span>
              </button>

              <ul className="thread-list">
                {items.map((executor) => {
                  const selected =
                    props.view.kind === 'executor' && props.view.executorId === executor.id;
                  const running = isRunning(executor.status);
                  return (
                    <li key={executor.id}>
                      <button
                        type="button"
                        className={`thread-item${selected ? ' active' : ''}`}
                        onClick={() => props.onOpenExecutor(project.id, executor.id)}
                        title={executor.label}
                      >
                        <span className="thread-title">{executor.label}</span>
                        <span className={`thread-status${running ? ' busy' : ''}`}>
                          {running ? summarize(executor.metrics) : EXECUTOR_STATUS_LABEL[executor.status]}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <span className={`dot${props.connected ? ' ok' : ' bad'}`} />
        <span>{props.connected ? '已连接' : '未连接'}</span>
        {props.connectionDetail && <span className="muted small">{props.connectionDetail}</span>}
        <button type="button" className="link" onClick={props.onOpenSettings}>
          设置
        </button>
      </div>

      {/* 拖拽把手：放在最右侧，2px 宽也够点中 */}
      <div className="sidebar-resizer" onMouseDown={onMouseDown} role="separator" aria-orientation="vertical" />
    </aside>
  );
}
