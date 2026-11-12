import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExecutorDto, ProjectDto } from '../api.js';
import { isFiltering, isRunning, matchExecutor, matchesProject } from './matching.js';
import { EXECUTOR_STATUS_LABEL } from '../state.js';
import { summarize } from '../metrics.js';

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
}

/** 侧栏宽度范围。DSH 也允许拖动，但有上下限——太窄看不清，太宽挤掉主区。 */
const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 244;  // DSH 源码里的固定值

const WIDTH_KEY = 'ocx.sidebarWidth';

function loadWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch {
    // localStorage 不可用时用默认值
  }
  return DEFAULT_WIDTH;
}

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
  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);

  const filtering = isFiltering(query, onlyRunning);

  // 拖拽调整宽度：鼠标移动即生效，松手才写回存储。
  const onMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!dragging.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX));
      setWidth(next);
    };
    const onUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth((w) => {
        try {
          window.localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          /* 存不了就算了 */
        }
        return w;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
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

      {/* 工作区标题行：带搜索/筛选/新建三个小图标（DSH 的做法） */}
      <div className="workspace-head">
        <span className="workspace-title">工作区</span>
        <span className="workspace-actions">
          <input
            className="workspace-search"
            value={query}
            placeholder="搜索"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索 Agent"
          />
          <button
            type="button"
            className={`icon-btn${onlyRunning ? ' active' : ''}`}
            title="只看在跑"
            onClick={() => setOnlyRunning((v) => !v)}
          >
            ⇅
          </button>
          <button type="button" className="icon-btn" title="新建项目" onClick={props.onOpenProject}>
            ＋
          </button>
        </span>
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
