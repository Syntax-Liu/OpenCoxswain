import { createContext, useContext, type ReactNode } from 'react';
import type {
  AcceptanceDecision,
  AcceptanceRecord,
  ArtifactRecord,
  Assistant,
  EventRecord,
  Evidence,
  Project,
  Task,
  TaskEdge,
  TaskStageView,
  Worker,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import type { TaskAction, WorkerAction } from './api.js';

export interface Workbench {
  snapshot: WorkbenchSnapshot;
  project: Project;
  assistant: Assistant;
  root: Task | null;
  children: Task[];
  edges: TaskEdge[];
  tasks: Task[];
  workers: Worker[];
  events: EventRecord[];
  artifacts: ArtifactRecord[];
  acceptance: AcceptanceRecord[];
  evidence: Evidence[];
  stages: TaskStageView[];
  summary: string | null;
  busy: boolean;
  onPlan: (goal: string, acceptanceCommand?: string) => Promise<boolean>;
  onTaskAction: (action: TaskAction, note?: string) => void;
  onAcceptance: (decisions: AcceptanceDecision[]) => void;
  onInput: (taskId: string, text: string) => void;
  onWorkerAction: (worker: Worker, action: WorkerAction) => void;
  onProjectSettings: (patch: {
    dailyBudgetUsd: number;
    maxConcurrency: number;
  }) => Promise<void>;
  onAssistant: (
    patch: Pick<Assistant, 'name' | 'tone' | 'proactivity'>,
  ) => Promise<void>;
}

const WorkbenchContext = createContext<Workbench | null>(null);

export function WorkbenchProvider({
  value,
  children,
}: {
  value: Workbench;
  children: ReactNode;
}): JSX.Element {
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error('界面面板必须在 WorkbenchProvider 内渲染');
  return workbench;
}
