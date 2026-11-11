/**
 * 导航筛选的纯逻辑。
 *
 * 抽成独立模块的原因：组件文件 import 了 React，
 * 测试环境里跑不动；这些函数本身和 React 无关，单独放更干净。
 */

export interface FilterableExecutor {
  readonly label: string;
  readonly goal: string;
  readonly status: string;
}

/** 是否在跑（含正在启动）。 */
export function isRunning(status: string): boolean {
  return status === 'running' || status === 'starting';
}

/**
 * 一个执行者是否符合筛选条件。
 *
 * 搜索同时匹配**标题与目标**——用户往往记得"让它改登录页"，
 * 但不记得当时起的是什么标题。
 */
export function matchExecutor(
  executor: FilterableExecutor,
  query: string,
  onlyRunning: boolean,
): boolean {
  if (onlyRunning && !isRunning(executor.status)) return false;

  const q = query.trim().toLowerCase();
  if (!q) return true;

  return executor.label.toLowerCase().includes(q) || executor.goal.toLowerCase().includes(q);
}

/** 项目名是否命中；用于决定筛选时是否保留整个文件夹。 */
export function matchesProject(
  project: { readonly name: string },
  query: string,
  onlyRunning: boolean,
): boolean {
  // "只看在跑"说明用户只关心正在进行的任务，文件夹名没有意义。
  if (onlyRunning) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return project.name.toLowerCase().includes(q);
}

/** 当前是否处于筛选状态。 */
export function isFiltering(query: string, onlyRunning: boolean): boolean {
  return query.trim() !== '' || onlyRunning;
}
