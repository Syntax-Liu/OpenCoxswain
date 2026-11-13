import type { TaskStatus } from '@opencoxswain/shared';

export interface DagTask {
  id: string;
  status: TaskStatus;
  writeScope: string[];
  readOnly: boolean;
  createdAt: number;
}

export interface DagEdge {
  fromTaskId: string;
  toTaskId: string;
}

/** 边方向：from 是前置任务，to 依赖 from。 */
export function dependenciesOf(taskId: string, edges: DagEdge[]): string[] {
  return edges.filter((edge) => edge.toTaskId === taskId).map((edge) => edge.fromTaskId);
}

export function validateDag(tasks: DagTask[], edges: DagEdge[]): string[] {
  const errors: string[] = [];
  const ids = new Set(tasks.map((task) => task.id));
  const seen = new Set<string>();

  for (const edge of edges) {
    if (edge.fromTaskId === edge.toTaskId) {
      errors.push(`任务 ${edge.fromTaskId} 不能依赖自己`);
    }
    if (!ids.has(edge.fromTaskId)) {
      errors.push(`依赖边引用了不存在的任务：${edge.fromTaskId}`);
    }
    if (!ids.has(edge.toTaskId)) {
      errors.push(`依赖边引用了不存在的任务：${edge.toTaskId}`);
    }
    const key = `${edge.fromTaskId}->${edge.toTaskId}`;
    if (seen.has(key)) {
      errors.push(`重复依赖边：${key}`);
    }
    seen.add(key);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`任务依赖存在环：${id}`);
      return;
    }
    visiting.add(id);
    for (const dependency of dependenciesOf(id, edges)) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) {
    visit(task.id);
  }

  return errors;
}

export function readyTaskIds(tasks: DagTask[], edges: DagEdge[]): string[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return tasks
    .filter((task) => task.status === 'queued')
    .filter((task) =>
      dependenciesOf(task.id, edges).every((dependency) => status.get(dependency) === 'done'),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((task) => task.id);
}

function normalizeScope(scope: string): string {
  const normalized = scope
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/\*+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalized === '*' || normalized === '**' || normalized === '**/*' ? '' : normalized;
}

/** 未声明写域视为“未知”，与任何写任务冲突；只读任务不参与互斥。 */
export function writeScopeConflicts(a: string[], b: string[]): boolean {
  const left = a.map(normalizeScope).filter(Boolean);
  const right = b.map(normalizeScope).filter(Boolean);
  if (left.length === 0 || right.length === 0) return true;
  for (const x of left) {
    for (const y of right) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) {
        return true;
      }
    }
  }
  return false;
}

export function hasWriteConflict(candidate: DagTask, running: DagTask[]): boolean {
  if (candidate.readOnly) return false;
  return running.some(
    (task) => !task.readOnly && writeScopeConflicts(candidate.writeScope, task.writeScope),
  );
}
