import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExecutorDto, ProjectDto } from '../api.js';
import { isFiltering, isRunning, matchExecutor, matchesProject } from './matching.js';
import { IconChevron, IconNewChat, IconSupervisor } from './icons.js';
import { computeBatchPositions } from './sidebarBatches.js';
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
    | { readonly kind: 'global' }
    /** 新会话空页：两个导航项都不算"当前项目"。 */
    | { readonly kind: 'new' };
  readonly connected: boolean;
  readonly connectionDetail: string | null;
  readonly onOpenAssistant: (projectId: string) => void;
  readonly onOpenExecutor: (projectId: string, executorId: string) => void;
  readonly onOpenGlobal: () => void;
  /**
   * 新建会话。
   *
   * **和以前不同**：以前它绑的是 onOpenProject（弹"打开项目"对话框），
   * 和「添加项目」完全重复。现在它进空会话页，
   * 在那里用输入框旁的选择器选项目。
   */
  readonly onNewSession: () => void;
  /** 顶部标题行的"新建项目"小按钮。 */
  readonly onOpenProject: () => void;
  readonly onOpenSettings: () => void;
  /** 删除一条会话（Agent）。 */
  readonly onDeleteExecutor?: (projectId: string, executorId: string) => void;
  /** 把项目移出工作区（不删磁盘文件）。 */
  readonly onRemoveProject?: (projectId: string) => void;
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

  /** 收起的项目 id。折叠状态是纯界面状态，不持久化。 */
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());

  /**
   * 右键菜单。
   *
   * 两种目标：会话（列出会话相关动作）和项目（列出项目相关动作）。
   * 合成一个状态而不是两个——同时只可能有一个菜单。
   */
  const [menu, setMenu] = useState<
    | { x: number; y: number; kind: 'executor'; projectId: string; executor: ExecutorDto }
    | { x: number; y: number; kind: 'project'; projectId: string; projectName: string }
    | null
  >(null);

  const toggleCollapse = (projectId: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // 点击别处关掉右键菜单
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menu]);

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
      {/* **「新会话」和「Supervisor」结构完全相同**。
          原来「新会话」在 .sidebar-top 里（自带 padding），
          「Supervisor」在 .nav-main 里——两者的盒子位置、内边距都不一样，
          看起来就有框/没框、缩进也不齐。

          现在两个都是 .nav-item，只有图标和文字不同。 */}
      <nav className="nav-main">
        <button
          type="button"
          className={`nav-item${props.view.kind === 'new' ? ' active' : ''}`}
          onClick={props.onNewSession}
        >
          <IconNewChat size={20} className="nav-icon" />
          新会话
        </button>
        <button
          type="button"
          className={`nav-item${props.view.kind === 'global' ? ' active' : ''}`}
          onClick={props.onOpenGlobal}
        >
          <IconSupervisor size={20} className="nav-icon is-triangle" />
          Supervisor
        </button>
        {/* **「添加项目」已移除**：它和「新会话」绑的是同一个 onOpenProject，
            点下去完全一样。现在"打开/新建项目"挪到新会话输入框旁的项目选择器里。 */}
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
                className="btn btn--ghost btn--sm btn--icon"
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
                className={`btn btn--ghost btn--sm btn--icon${onlyRunning ? ' active' : ''}`}
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
          <button type="button" className="btn btn--ghost btn--sm btn--icon" title="新建项目" onClick={props.onOpenProject}>
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
          const projectMatches = matchesProject(project, query, onlyRunning);
          const collapsed = collapsedIds.has(project.id);
          const items = props.executors.filter(
            (e) => e.projectId === project.id && matchExecutor(e, query, onlyRunning),
          );
          // 批次位置：同一轮派的会话在侧栏里连成一组
          const groupInfo = computeBatchPositions(items);
          if (filtering && !projectMatches && items.length === 0) return null;

          const active =
            (props.view.kind === 'assistant' && props.view.projectId === project.id) ||
            (props.view.kind === 'executor' && props.view.projectId === project.id);

          return (
            <div className="project-group" key={project.id}>
              {/* 文件夹行拆成两半：箭头负责折叠，名字负责进入。
                  DSH / VS Code 都是这个惯例，整行一个按钮会让人误点。 */}
              <div
                className={`project-folder${active ? ' active' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    kind: 'project',
                    projectId: project.id,
                    projectName: project.name,
                  });
                }}
              >
                <button
                  type="button"
                  className="btn btn--ghost btn--sm folder-toggle"
                  aria-label={collapsed ? '展开' : '收起'}
                  aria-expanded={!collapsed}
                  onClick={() => toggleCollapse(project.id)}
                >
                  <span className={`folder-icon${collapsed ? ' collapsed' : ''}`}>
                    <IconChevron size={12} direction="down" />
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn--link folder-name-btn"
                  onClick={() => props.onOpenAssistant(project.id)}
                  title={project.displayPath}
                >
                  <span className="folder-name">{project.name}</span>
                </button>
              </div>

              {!collapsed && (
                <ul className="thread-list">
                  {items.map((executor, itemIndex) => {
                    const selected =
                      props.view.kind === 'executor' && props.view.executorId === executor.id;
                    const running = isRunning(executor.status);
                    // 同一批的会话连成一组（看看它们是谁一起派的）
                    const group = groupInfo[itemIndex];
                    const batchClass =
                      group && group.position !== 'none' ? `batch-${group.position}` : undefined;
                    return (
                      <li
                        key={executor.id}
                        className={batchClass}
                        {...(group && group.position === 'first'
                          ? { title: `这一批共 ${group.batchSize} 个 Agent` }
                          : {})}
                      >
                        <button
                          type="button"
                          className={`thread-item${selected ? ' active' : ''}`}
                          onClick={() => props.onOpenExecutor(project.id, executor.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            // 标记已处理：全站的右键菜单看到这个标记就不再弹，
                            // 否则两层菜单会叠加在一起。
                            (e.nativeEvent as MouseEvent & { __ocxHandled?: boolean }).__ocxHandled = true;
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              kind: 'executor',
                              projectId: project.id,
                              executor,
                            });
                          }}
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
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <span className={`dot${props.connected ? ' ok' : ' bad'}`} />
        <span>{props.connected ? '已连接' : '未连接'}</span>
        {props.connectionDetail && <span className="muted small">{props.connectionDetail}</span>}
        <button type="button" className="btn btn--link" onClick={props.onOpenSettings}>
          设置
        </button>
      </div>

      {/* 拖拽把手：放在最右侧，2px 宽也够点中 */}
      <div className="sidebar-resizer" onMouseDown={onMouseDown} role="separator" aria-orientation="vertical" />

      {/* 右键菜单（照 TRAE / VS Code 的组织方式） */}
      {menu && (
        <div
          className="ctx-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 200),
          }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {menu.kind === 'executor' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onOpenExecutor(menu.projectId, menu.executor.id);
                  setMenu(null);
                }}
              >
                打开会话
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(menu.executor.id);
                  setMenu(null);
                }}
              >
                复制会话 ID
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                disabled={isRunning(menu.executor.status)}
                title={isRunning(menu.executor.status) ? '正在运行，先停止再删除' : '删除这条会话'}
                onClick={() => {
                  const target = menu.executor;
                  setMenu(null);
                  props.onDeleteExecutor?.(menu.projectId, target.id);
                }}
              >
                删除会话
              </button>
            </>
          )}

          {menu.kind === 'project' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  props.onOpenAssistant(menu.projectId);
                  setMenu(null);
                }}
              >
                打开 Assistant
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void navigator.clipboard?.writeText(menu.projectName);
                  setMenu(null);
                }}
              >
                复制项目名
              </button>
              <div className="ctx-sep" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                title="从工作区移除（不删除磁盘文件）"
                onClick={() => {
                  const target = menu.projectId;
                  setMenu(null);
                  props.onRemoveProject?.(target);
                }}
              >
                移除项目
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
