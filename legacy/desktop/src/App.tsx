import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AcceptanceDecision,
  Assistant,
  DeliveryMergeResult,
  DeliveryPlan,
  Project,
  RoleName,
  Task,
  Worker,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import {
  api,
  errorText,
  subscribeEvents,
  type TaskAction,
  type WorkerAction,
} from './api.js';
import { Setup } from './components/Setup.js';
import { pendingDecisionCount } from './components/Inbox.js';
import { useUiPanels, type UiRegistry } from './plugins/registry.js';
import { StatusChip } from './ui.js';
import { WorkbenchProvider, type Workbench } from './workbench.js';

const SETTLED = ['done', 'cancelled', 'failed'];
const CURRENT_PROJECT_KEY = 'opencoxswain.currentProject';
const CONTEXT_KEY = 'opencoxswain.contextPanel';

const NAV_PATHS: Record<string, string> = {
  'page.conversation': 'M4.5 5.5h15v10h-8l-4.5 3.5v-3.5h-2.5z',
  'page.inbox': 'M4.5 5.5h15l1 8v4.5h-17v-4.5zM4.5 13.5h4l1.5 2.5h4l1.5-2.5h4',
  'page.task-tree': 'M5 5h6v4.5H5zM13 14.5h6V19h-6zM8 9.5v4h5M16 14.5v-4h-5',
  'page.artifacts': 'M7 3.5h7l4 4v13H7zM14 3.5v4h4',
  'page.schedule': 'M12 7.5v4.5l3 2M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z',
  'page.memory': 'M6.5 4h9a2.5 2.5 0 0 1 2.5 2.5v13.5H8a1.5 1.5 0 0 1-1.5-1.5zM9 8h6M9 11.5h6',
  'page.cost': 'M4.5 6.5h15v11h-15zM4.5 10.5h15M8 14.5h3',
  'page.settings': 'M5 7.5h14M5 12h14M5 16.5h14M9 5.5v4M15 10v4M11 14.5v4',
  'page.projects': 'M4.5 6h6l2 2h7v10.5h-15z',
};

function NavIcon({ id }: { id: string }): JSX.Element {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d={NAV_PATHS[id] ?? 'M5 5h14v14H5z'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_PROJECT_KEY);
  } catch {
    return null;
  }
}

function readContextOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(CONTEXT_KEY);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    // 存储不可用时按窗口宽度给默认值。
  }
  return window.innerWidth >= 1180;
}

function storeContextOpen(open: boolean): void {
  try {
    window.localStorage.setItem(CONTEXT_KEY, open ? 'open' : 'closed');
  } catch {
    // 忽略存储失败。
  }
}

function storeProject(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(CURRENT_PROJECT_KEY, id);
    else window.localStorage.removeItem(CURRENT_PROJECT_KEY);
  } catch {
    // 存储不可用时不阻断使用，只是下次启动回到默认项目。
  }
}

export function App({ registry }: { registry: UiRegistry }): JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => readStoredProject());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryPlan | null>(null);
  const [deliveryResult, setDeliveryResult] = useState<DeliveryMergeResult | null>(null);
  const [merging, setMerging] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [pageId, setPageId] = useState('page.conversation');
  const [contextOpen, setContextOpen] = useState(() => readContextOpen());
  const [contextTabId, setContextTabId] = useState<string | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const pages = useUiPanels(registry, 'page');
  const contextPanels = useUiPanels(registry, 'context');

  projectIdRef.current = projectId;

  const load = useCallback(async (id: string | null, first = false): Promise<void> => {
    // 窗口比 daemon 先出来，首次加载要给它一点启动时间，别一上来就报错。
    const attempts = first ? 20 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const data = await api.snapshot(id ?? undefined);
        setSnapshot(data);
        setProjectId(data.project?.id ?? null);
        storeProject(data.project?.id ?? null);
        setError(null);
        if (first) setInitializing(false);
        return;
      } catch (caught) {
        if (attempt === attempts - 1) {
          setError(errorText(caught));
          if (first) setInitializing(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }, []);

  useEffect(() => {
    void load(projectIdRef.current, true);
  }, [load]);

  // 切换项目时清掉上一个项目的审阅与交付上下文，避免串台。
  useEffect(() => {
    setReviewTaskId(null);
    setDelivery(null);
    setDeliveryResult(null);
  }, [snapshot?.project?.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeEvents(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(projectIdRef.current), 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [load]);

  const run = useCallback(
    async (operation: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await operation();
        await load(projectIdRef.current);
        return true;
      } catch (caught) {
        setError(errorText(caught));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const roots = snapshot ? snapshot.tasks.filter((task) => task.parentId === null) : [];
  const root: Task | null =
    roots.find((task) => !SETTLED.includes(task.status)) ?? roots[roots.length - 1] ?? null;
  const children: Task[] =
    snapshot && root ? snapshot.tasks.filter((task) => task.parentId === root.id) : [];
  const treeIds = new Set<string>(root ? [root.id, ...children.map((child) => child.id)] : []);
  const workers: Worker[] =
    snapshot?.workers.filter((worker) => treeIds.has(worker.taskId)) ?? [];
  const events =
    snapshot?.events.filter((event) => event.taskId === null || treeIds.has(event.taskId)) ?? [];
  const artifacts = snapshot?.artifacts.filter((item) => treeIds.has(item.taskId)) ?? [];
  const acceptance = snapshot?.acceptance.filter((item) => treeIds.has(item.taskId)) ?? [];
  const evidence = snapshot?.evidence.filter((item) => treeIds.has(item.taskId)) ?? [];
  const stages = snapshot?.stages.filter((view) => treeIds.has(view.taskId)) ?? [];
  const treeTasks = root ? [root, ...children] : [];
  const reviewTask: Task | null =
    treeTasks.find((task) => task.id === reviewTaskId && task.status === 'awaiting_review') ??
    (root?.status === 'awaiting_review'
      ? root
      : children.find((task) => task.status === 'awaiting_review') ?? null);
  const reviewBrief =
    snapshot?.briefs.find((brief) => brief.taskId === reviewTask?.id) ?? null;

  useEffect(() => {
    if (!root || root.status !== 'done') {
      setDelivery(null);
      setDeliveryResult(null);
      return;
    }
    let cancelled = false;
    api
      .delivery(root.id)
      .then((plan) => {
        if (!cancelled) setDelivery(plan);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorText(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [root?.id, root?.status]);

  const onPlan = async (
    goal: string,
    acceptanceCommand?: string,
    templateId?: string,
  ): Promise<boolean> => {
    const project = snapshot?.project;
    if (!project) return false;
    return run(() => api.createPlan(project.id, goal, acceptanceCommand, templateId));
  };

  const onTaskAction = (action: TaskAction, note?: string): void => {
    if (!root) return;
    void run(() => api.taskAction(root.id, action, note));
  };

  const onTaskActionFor = (taskId: string, action: TaskAction): void => {
    void run(() => api.taskAction(taskId, action));
  };

  const onReassign = (taskId: string, role: RoleName): void => {
    void run(() => api.reassignTask(taskId, role));
  };

  const onApproval = (approvalId: string, status: 'approved' | 'rejected'): void => {
    void run(() => api.decideApproval(approvalId, status));
  };

  const onAcceptance = (decisions: AcceptanceDecision[]): void => {
    if (!reviewTask) return;
    void run(() => api.decideAcceptance(reviewTask.id, decisions));
  };

  const onReview = (taskId: string): void => {
    setReviewTaskId(taskId);
    setPageId('page.task-tree');
    void run(() => api.markViewed(taskId));
  };

  const onMerge = (planHash: string): void => {
    if (!root) return;
    setMerging(true);
    void api
      .mergeDelivery(root.id, planHash)
      .then(async ({ result }) => {
        setDeliveryResult(result);
        await load(projectIdRef.current);
      })
      .catch((caught) => {
        setError(errorText(caught));
        void api
          .delivery(root.id)
          .then(setDelivery)
          .catch(() => undefined);
      })
      .finally(() => setMerging(false));
  };

  const onInput = (taskId: string, text: string): void => {
    void run(() => api.sendInput(taskId, text));
  };

  const onWorkerAction = (worker: Worker, action: WorkerAction): void => {
    void run(() => api.workerAction(worker.id, action));
  };

  const onProjectSettings = async (patch: {
    dailyBudgetUsd: number;
    maxConcurrency: number;
  }): Promise<void> => {
    const project = snapshot?.project;
    if (!project) return;
    await api.updateProjectSettings(project.id, patch);
    await load(project.id);
  };

  const onAssistant = async (
    patch: Pick<Assistant, 'name' | 'tone' | 'proactivity'>,
  ): Promise<void> => {
    await api.updateAssistant(patch);
    await load(projectIdRef.current);
  };

  const onSwitchProject = (next: string): void => {
    setProjectId(next);
    storeProject(next);
    void load(next);
  };

  const onProjectReady = (project: Project): void => {
    setProjectId(project.id);
    storeProject(project.id);
    void load(project.id);
  };

  if (initializing) {
    return <main className="loading">正在连接本地 Daemon…</main>;
  }

  if (!snapshot) {
    return (
      <main className="loading">
        <p>{error ?? '无法读取工作台状态'}</p>
        <p className="hint">请确认 Daemon 已启动（默认 http://127.0.0.1:47821）。</p>
        <button className="primary" onClick={() => void load(projectId)}>
          重试
        </button>
      </main>
    );
  }

  if (!snapshot.project) {
    return (
      <>
        <Setup onReady={onProjectReady} />
        {error ? <div className="toast">{error}</div> : null}
      </>
    );
  }

  const project = snapshot.project;
  const workbench: Workbench = {
    snapshot,
    project,
    assistant: snapshot.assistant,
    root,
    children,
    edges: snapshot.edges,
    tasks: treeTasks,
    workers,
    events,
    artifacts,
    acceptance,
    evidence,
    stages,
    summary: snapshot.summary,
    reviewTask,
    reviewBrief,
    delivery,
    deliveryResult,
    merging,
    busy,
    onPlan,
    onTaskAction,
    onTaskActionFor,
    onReassign,
    onApproval,
    onAcceptance,
    onReview,
    onMerge,
    onInput,
    onWorkerAction,
    onSwitchProject,
    onProjectReady,
    onProjectSettings,
    onAssistant,
  };

  const navPages = pages.filter(
    (page) => page.id !== 'page.projects' && page.id !== 'page.settings',
  );
  const settingsPage = pages.find((page) => page.id === 'page.settings') ?? null;
  const activePage = pages.find((page) => page.id === pageId) ?? pages[0] ?? null;
  const activeContext =
    contextPanels.find((panel) => panel.id === contextTabId) ?? contextPanels[0] ?? null;
  const pending = pendingDecisionCount(root, treeTasks, snapshot.approvals);
  const ActivePage = activePage?.render;
  const ActiveContext = activeContext?.render;

  const toggleContext = (): void => {
    const next = !contextOpen;
    setContextOpen(next);
    storeContextOpen(next);
  };

  const startNewTask = (): void => {
    setPageId('page.conversation');
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
    }, 30);
  };

  return (
    <WorkbenchProvider value={workbench}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="mark">舵</span>
            <div>
              <strong>OpenCoxswain</strong>
              <small>本地 AI 总管</small>
            </div>
          </div>

          <button className="new-task" onClick={startNewTask}>
            <span className="plus">+</span>
            新建任务
          </button>

          <nav className="nav">
            {navPages.map((page) => (
              <button
                key={page.id}
                className={page.id === activePage?.id ? 'nav-item active' : 'nav-item'}
                onClick={() => setPageId(page.id)}
              >
                <NavIcon id={page.id} />
                <span>{page.title}</span>
                {page.id === 'page.inbox' && pending > 0 ? (
                  <span className="nav-badge">{pending}</span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="sidebar-section">
            <div className="sidebar-label">
              <span>项目</span>
              <button className="link" onClick={() => setPageId('page.projects')}>
                管理
              </button>
            </div>
            <div className="project-list">
              {snapshot.projects.map((item) => (
                <button
                  key={item.id}
                  className={item.id === project.id ? 'project-item active' : 'project-item'}
                  onClick={() => onSwitchProject(item.id)}
                  title={item.path}
                >
                  <span className="project-dot" />
                  <span className="project-name">{item.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-foot">
            <div className="run-status">
              <span
                className={snapshot.planner.mode === 'llm' ? 'status-dot ok' : 'status-dot warn'}
                title={snapshot.planner.reason ?? 'LLM Planner 已启用'}
              />
              <span>{snapshot.planner.mode === 'llm' ? 'LLM 规划' : '静态规划'}</span>
            </div>
            <div className="run-status">
              <span
                className={snapshot.runtime.ok ? 'status-dot ok' : 'status-dot bad'}
                title={snapshot.runtime.detail}
              />
              <span>
                {snapshot.runtime.adapter} {snapshot.runtime.ok ? '就绪' : '异常'}
              </span>
            </div>
            {settingsPage ? (
              <button
                className={settingsPage.id === activePage?.id ? 'nav-item active' : 'nav-item'}
                onClick={() => setPageId(settingsPage.id)}
              >
                <NavIcon id={settingsPage.id} />
                <span>{settingsPage.title}</span>
              </button>
            ) : null}
          </div>
        </aside>

        <main className="main-area">
          <header className="main-head">
            <h1>{activePage?.title ?? '工作台'}</h1>
            {activePage?.id === 'page.inbox' && pending > 0 ? (
              <span className="head-badge">{pending} 项待处理</span>
            ) : null}
            {(activePage?.id === 'page.conversation' ||
              activePage?.id === 'page.task-tree') &&
            root ? (
              <StatusChip status={root.status} />
            ) : null}
            <div className="main-actions">
              <button
                className="icon-btn"
                onClick={() => void load(projectId)}
                title="刷新"
                aria-label="刷新"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className={contextOpen ? 'icon-btn active' : 'icon-btn'}
                onClick={toggleContext}
                title={contextOpen ? '收起上下文面板' : '展开上下文面板'}
                aria-label="切换上下文面板"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="M4.5 5h15v14h-15zM15 5v14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </header>

          <div className="page" data-page={activePage?.id}>
            <div className="page-body">{ActivePage ? <ActivePage /> : null}</div>
          </div>
        </main>

        {contextOpen ? (
          <aside className="context">
            <header className="context-head">
              <nav>
                {contextPanels.map((panel) => (
                  <button
                    key={panel.id}
                    className={
                      panel.id === activeContext?.id ? 'context-tab active' : 'context-tab'
                    }
                    onClick={() => setContextTabId(panel.id)}
                  >
                    {panel.title}
                  </button>
                ))}
              </nav>
              <button
                className="icon-btn"
                onClick={toggleContext}
                title="收起上下文面板"
                aria-label="收起上下文面板"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="m9 6 6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </header>
            <div className="context-body">{ActiveContext ? <ActiveContext /> : null}</div>
          </aside>
        ) : null}

        {error ? (
          <div className="toast">
            <span>{error}</span>
            <button className="ghost" onClick={() => setError(null)}>
              关闭
            </button>
          </div>
        ) : null}
      </div>
    </WorkbenchProvider>
  );
}
