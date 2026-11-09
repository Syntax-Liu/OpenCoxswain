import { useCallback, useEffect, useRef, useState } from 'react';
import type {
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
import { Conversation } from './components/Conversation.js';
import { Inspector } from './components/Inspector.js';
import { Setup } from './components/Setup.js';
import { TaskTree } from './components/TaskTree.js';
import { WorkerBoard } from './components/WorkerBoard.js';

const SETTLED = ['done', 'cancelled', 'failed'];

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const projectIdRef = useRef<string | null>(null);

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

  const onPlan = async (goal: string, acceptanceCommand?: string): Promise<boolean> => {
    const project = snapshot?.project;
    if (!project) return false;
    return run(() => api.createPlan(project.id, goal, acceptanceCommand));
  };

  const onTaskAction = (action: TaskAction, note?: string): void => {
    if (!root) return;
    void run(() => api.taskAction(root.id, action, note));
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

  return (
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
            value={snapshot.project.id}
            onChange={(event) => {
              const next = event.target.value;
              setProjectId(next);
              void load(next);
            }}
            aria-label="选择项目"
          >
            {snapshot.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="muted" title={snapshot.project.path}>
            {snapshot.project.path}
          </span>
        </div>
        <div className="topbar-right">
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
        <TaskTree
          root={root}
          children={children}
          edges={snapshot.edges}
          busy={busy}
          onAction={(action) => onTaskAction(action)}
        />
        <Conversation
          messages={snapshot.messages}
          root={root}
          children={children}
          busy={busy}
          onPlan={onPlan}
          onAction={onTaskAction}
        />
        <WorkerBoard
          workers={workers}
          tasks={root ? [root, ...children] : []}
          busy={busy}
          onAction={onWorkerAction}
        />
      </main>

      <Inspector
        project={snapshot.project}
        assistant={snapshot.assistant}
        tasks={root ? [root, ...children] : []}
        workers={workers}
        events={events}
        artifacts={artifacts}
        summary={snapshot.summary}
        busy={busy}
        onProjectSettings={onProjectSettings}
        onAssistant={onAssistant}
      />

      {error ? (
        <div className="toast">
          <span>{error}</span>
          <button className="ghost" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      ) : null}
    </div>
  );
}
