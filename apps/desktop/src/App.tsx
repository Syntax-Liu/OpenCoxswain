import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AcceptanceDecision,
  Assistant,
  Project,
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
import { Inspector } from './components/Inspector.js';
import { Setup } from './components/Setup.js';
import { PanelSlot, useUiPanels, type UiRegistry } from './plugins/registry.js';
import { WorkbenchProvider, type Workbench } from './workbench.js';

const SETTLED = ['done', 'cancelled', 'failed'];

export function App({ registry }: { registry: UiRegistry }): JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const projectIdRef = useRef<string | null>(null);
  const bottomTabs = useUiPanels(registry, 'bottom');

  projectIdRef.current = projectId;

  const load = useCallback(async (id: string | null, first = false): Promise<void> => {
    try {
      const data = await api.snapshot(id ?? undefined);
      setSnapshot(data);
      setProjectId(data.project?.id ?? null);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      if (first) setInitializing(false);
    }
  }, []);

  useEffect(() => {
    void load(null, true);
  }, [load]);

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

  const onPlan = async (goal: string, acceptanceCommand?: string): Promise<boolean> => {
    const project = snapshot?.project;
    if (!project) return false;
    return run(() => api.createPlan(project.id, goal, acceptanceCommand));
  };

  const onTaskAction = (action: TaskAction, note?: string): void => {
    if (!root) return;
    void run(() => api.taskAction(root.id, action, note));
  };

  const onAcceptance = (decisions: AcceptanceDecision[]): void => {
    if (!root) return;
    void run(() => api.decideAcceptance(root.id, decisions));
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

  const onProjectReady = (project: Project): void => {
    setProjectId(project.id);
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
    tasks: root ? [root, ...children] : [],
    workers,
    events,
    artifacts,
    acceptance,
    evidence,
    stages,
    summary: snapshot.summary,
    busy,
    onPlan,
    onTaskAction,
    onAcceptance,
    onInput,
    onWorkerAction,
    onProjectSettings,
    onAssistant,
  };

  return (
    <WorkbenchProvider value={workbench}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="mark">舵</span>
            <div>
              <strong>OpenCoxswain</strong>
              <small>舵手 · 本地 AI 总管</small>
            </div>
          </div>
          <div className="project-switch">
            <select
              value={project.id}
              onChange={(event) => {
                const next = event.target.value;
                setProjectId(next);
                void load(next);
              }}
              aria-label="选择项目"
            >
              {snapshot.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="muted" title={project.path}>
              {project.path}
            </span>
          </div>
          <div className="topbar-right">
            <span
              className={snapshot.planner.mode === 'llm' ? 'runtime ok' : 'runtime warn'}
              title={snapshot.planner.reason ?? 'LLM Planner 已启用'}
            >
              规划 · {snapshot.planner.mode === 'llm' ? 'LLM' : '静态回退'}
            </span>
            <span
              className={snapshot.runtime.ok ? 'runtime ok' : 'runtime bad'}
              title={snapshot.runtime.detail}
            >
              {snapshot.runtime.adapter} · {snapshot.runtime.ok ? '就绪' : '异常'}
            </span>
            <button className="ghost" onClick={() => void load(projectId)}>
              刷新
            </button>
          </div>
        </header>

        <main className="workspace">
          <PanelSlot registry={registry} slot="left" />
          <PanelSlot registry={registry} slot="center" />
          <PanelSlot registry={registry} slot="right" />
        </main>

        <Inspector tabs={bottomTabs} />

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
