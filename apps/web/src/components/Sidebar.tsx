import type { ExecutorDto, ProjectDto } from '../api.js';
import { EXECUTOR_STATUS_LABEL } from '../state.js';
import { summarize } from '../metrics.js';

export interface SidebarProps {
  readonly projects: readonly ProjectDto[];
  readonly executors: readonly ExecutorDto[];
  readonly currentProjectId: string | null;
  /** 当前主区展示的是哪个：项目（= C）还是某个执行者（= D）。 */
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

/**
 * 左侧导航，结构对齐主流 Agent 软件（DeepSeek / TRAE）：
 *
 * ```
 * [B 全局助理]
 * ──────────
 * 工作区
 *  ▾ 项目文件夹        ← 点击 = 进项目助理 C
 *     · 对话标题        ← 点击 = 看某个执行者 D
 * ```
 *
 * 每个项目是一个"文件夹"，文件夹本身是 C；文件夹下的每条记录是一个 D。
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <nav className="nav-main">
        <button
          type="button"
          className={`nav-item${props.view.kind === 'global' ? ' active' : ''}`}
          onClick={props.onOpenGlobal}
        >
          <span className="nav-icon">◎</span>
          全局助理 · B
        </button>
        <button type="button" className="nav-item" onClick={props.onOpenProject}>
          <span className="nav-icon">＋</span>
          添加项目
        </button>
      </nav>

      <div className="workspace-head">
        <span>工作区</span>
      </div>

      <nav className="workspace-tree">
        {props.projects.length === 0 && (
          <p className="muted small empty-hint">还没有项目，先「添加项目」。</p>
        )}
        {props.projects.map((project) => {
          const executors = props.executors.filter((e) => e.projectId === project.id);
          const isCurrentProject = props.currentProjectId === project.id;
          const circleActive = props.view.kind === 'assistant' && isCurrentProject;
          return (
            <div className="project-group" key={project.id}>
              <button
                type="button"
                className={`project-folder${circleActive ? ' active' : ''}`}
                onClick={() => props.onOpenAssistant(project.id)}
                title={project.displayPath}
              >
                <span className="folder-icon">◇</span>
                <span className="folder-name">{project.name}</span>
                {project.running ? <span className="badge running">{project.running}</span> : null}
              </button>

              {/* 文件夹下的每条 = 一个执行者 D 的对话 */}
              {executors.length > 0 && (
                <ul className="thread-list">
                  {[...executors]
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((executor) => {
                      const active =
                        props.view.kind === 'executor' && props.view.executorId === executor.id;
                      return (
                        <li key={executor.id}>
                          <button
                            type="button"
                            className={`thread-item${active ? ' active' : ''}`}
                            onClick={() => props.onOpenExecutor(project.id, executor.id)}
                            title={executor.goal}
                          >
                            <span className={`thread-dot ${dotClass(executor.status)}`} />
                            <span className="thread-title">{executor.label}</span>
                            <span className="thread-status">
                              {summarize(executor.metrics) ?? EXECUTOR_STATUS_LABEL[executor.status]}
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
      </nav>

      <div className="sidebar-foot">
        <div className="conn" title={props.connectionDetail ?? undefined}>
          <span className={`dot${props.connected ? ' ok' : ''}`} />
          {props.connected ? '已连接' : '未连接'}
        </div>
        <button type="button" className="link" onClick={props.onOpenSettings}>
          设置
        </button>
      </div>
    </aside>
  );
}

function dotClass(status: ExecutorDto['status']): string {
  if (status === 'running' || status === 'starting') return 'busy';
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'bad';
  return 'idle';
}
