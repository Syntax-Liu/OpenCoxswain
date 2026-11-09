import type { RoleName, TaskContract } from '@opencoxswain/shared';

export const PLAN_NOT_DECOMPOSED = 'PLAN_NOT_DECOMPOSED';

const WORKER_ROLES: ReadonlySet<RoleName> = new Set(['implementer', 'writer']);
const VERIFY_ROLES: ReadonlySet<RoleName> = new Set(['verifier']);

export interface DelegationPolicy {
  /** 非平凡任务的判定：目标长度、是否含多动词、写域数量。 */
  isTrivial(task: TaskContract): boolean;
  /** 非平凡任务必须有子任务，且角色覆盖可执行与校验；返回空数组表示通过。 */
  validate(root: TaskContract, children: TaskContract[]): string[];
}

export function isTrivial(task: TaskContract): boolean {
  const goal = task.goal.trim();
  const multiVerb = /(并且|然后|同时|以及|再|且)/.test(goal);
  return goal.length < 20 && !multiVerb && (task.write_scope?.length ?? 0) <= 1;
}

export function validateDelegation(
  root: TaskContract,
  children: TaskContract[],
): string[] {
  if (isTrivial(root)) return [];
  const errors: string[] = [];
  if (children.length === 0) {
    errors.push(`${PLAN_NOT_DECOMPOSED}：非平凡任务必须拆分为子任务`);
    return errors;
  }
  if (children.some((child) => !child.assignee?.role)) {
    errors.push('子任务缺少执行角色');
  }
  if (!children.some((child) => child.assignee && WORKER_ROLES.has(child.assignee.role))) {
    errors.push('子任务缺少可执行的实施/撰写角色');
  }
  const hasVerifier = children.some(
    (child) => child.assignee && VERIFY_ROLES.has(child.assignee.role),
  );
  if (!hasVerifier && !root.review?.required) {
    errors.push('缺少校验子任务或人审要求');
  }
  return errors;
}

export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = {
  isTrivial,
  validate: validateDelegation,
};
