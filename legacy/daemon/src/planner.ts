import {
  newId,
  type AcceptanceCriterion,
  type AcceptancePolicy,
  type Budget,
  type CreatePlanRequest,
  type Deliverable,
  type DeliverableProfile,
  type Project,
  type PlannerStatus,
  type RoleName,
  type SubtaskDraft,
  type TaskContract,
} from '@opencoxswain/shared';
import { PLAN_NOT_DECOMPOSED, sumBudgets, validateDag, validateTaskContract } from '@opencoxswain/core';
import type { EmployeeRegistry } from '@opencoxswain/plugin-api';

const DEFAULT_BUDGET: Budget = { usd: 2, tokens: 200_000, minutes: 30 };

export interface PlanEdge {
  fromTaskId: string;
  toTaskId: string;
}

export interface PlanResult {
  root: TaskContract;
  children: TaskContract[];
  edges: PlanEdge[];
}

export function shortTitle(goal: string): string {
  const normalized = goal.replace(/\s+/g, ' ').trim();
  return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized;
}

function defaultDeliverables(role: RoleName, scope?: string): Deliverable[] {
  switch (role) {
    case 'implementer':
      return [{ type: 'diff', scope: scope ?? '**' }];
    case 'verifier':
      return [{ type: 'report' }];
    case 'researcher':
      return [{ type: 'report' }];
    case 'writer':
      return [{ type: 'file' }];
  }
}

export interface PlannerOptions {
  /** 任务派发使用的运行时，默认 mock。 */
  runtime?: string;
  /** 覆盖角色默认模型；为空时 mock 使用 mock-<role>，其他运行时使用其默认模型。 */
  model?: string;
  /** 员工注册表：只读属性与默认验收标准由员工插件包提供。 */
  employees?: Pick<EmployeeRegistry, 'get'>;
}

export class Planner {
  async status(): Promise<PlannerStatus> {
    return { mode: 'static', reason: '使用内置静态拆分' };
  }

  constructor(private readonly options: PlannerOptions = {}) {}

  plan(project: Project, request: CreatePlanRequest): PlanResult {
    const goal = request.goal?.trim();
    if (!goal) throw new Error('goal 不能为空');

    const drafts = request.subtasks && request.subtasks.length > 0
      ? request.subtasks
      : this.defaultDrafts(request);
    if (drafts.length < 2 || drafts.length > 5) {
      throw new Error(`${PLAN_NOT_DECOMPOSED}：子任务数量需在 2-5 之间`);
    }

    const rootId = newId('tsk');
    const planId = newId('pln');
    const ids = drafts.map(() => newId('tsk'));
    const budgets = this.splitBudget(request.budget ?? DEFAULT_BUDGET, drafts);
    const policy = request.acceptancePolicy ?? 'unverified_only';
    const children = drafts.map((draft, index) =>
      this.buildChild(
        project,
        rootId,
        ids[index]!,
        draft,
        budgets[index]!,
        planId,
        policy,
        request.deliverableProfile,
      ),
    );

    const edges: PlanEdge[] = [];
    drafts.forEach((draft, index) => {
      for (const dependency of draft.dependsOn ?? []) {
        if (!Number.isInteger(dependency) || dependency < 0 || dependency >= drafts.length) {
          throw new Error(`子任务 ${index} 的 dependsOn 越界：${dependency}`);
        }
        if (dependency === index) {
          throw new Error(`子任务 ${index} 不能依赖自己`);
        }
        edges.push({ fromTaskId: ids[dependency]!, toTaskId: ids[index]! });
      }
    });

    const dagErrors = validateDag(
      children.map((child) => ({
        id: child.task_id,
        status: 'queued' as const,
        writeScope: child.write_scope ?? [],
        readOnly: this.isReadOnly(child.assignee?.role),
        createdAt: 0,
      })),
      edges,
    );
    if (dagErrors.length > 0) {
      throw new Error(`任务 DAG 非法：${dagErrors.join('；')}`);
    }

    const root: TaskContract = {
      task_id: rootId,
      parent_id: null,
      project_id: project.id,
      plan_id: planId,
      plan_revision: 1,
      delegated_by: 'planner',
      delegation_mode: 'fixed',
      title: shortTitle(goal),
      goal,
      deliverables: this.mergeDeliverables(children),
      constraints: [],
      acceptance_criteria: [],
      acceptance_policy: policy,
      deliverable_profile: request.deliverableProfile,
      dependencies: [],
      budget: request.budget ?? sumBudgets(budgets),
      review: { required: true, reviewer_role: 'verifier' },
    };

    for (const contract of [root, ...children]) {
      const validation = validateTaskContract(contract);
      if (!validation.ok) {
        throw new Error(`任务单字段不完整：${validation.errors.join('；')}`);
      }
    }

    return { root, children, edges };
  }

  private defaultDrafts(request: CreatePlanRequest): SubtaskDraft[] {
    const implementerAcceptance = this.acceptanceDefaults('implementer');
    const verifierAcceptance = this.acceptanceDefaults('verifier');
    if (request.acceptanceCommand) {
      implementerAcceptance.unshift({
        id: 'ac1',
        type: 'command',
        desc: '验收命令通过',
        check: request.acceptanceCommand,
      });
      verifierAcceptance.unshift({
        id: 'ac1',
        type: 'command',
        desc: '独立复跑验收命令',
        check: request.acceptanceCommand,
      });
    }

    return [
      {
        title: `实施：${shortTitle(request.goal)}`,
        goal: request.goal,
        role: 'implementer',
        acceptance: implementerAcceptance,
        writeScope: ['**'],
        deliverables: [{ type: 'diff', scope: '**' }],
      },
      {
        title: `校验：${shortTitle(request.goal)}`,
        goal: `独立复跑验收并检查 diff：${request.goal}`,
        role: 'verifier',
        dependsOn: [0],
        acceptance: verifierAcceptance,
        deliverables: [{ type: 'report' }],
      },
    ];
  }

  private splitBudget(root: Budget, drafts: SubtaskDraft[]): Budget[] {
    const count = drafts.length;
    const share = (value?: number): number | undefined =>
      value === undefined ? undefined : value / count;
    return drafts.map((draft) => {
      const base: Budget = {
        tokens: share(root.tokens) === undefined ? undefined : Math.max(1, Math.floor(share(root.tokens)!)),
        usd: share(root.usd),
        minutes: share(root.minutes) === undefined ? undefined : Math.max(1, Math.ceil(share(root.minutes)!)),
      };
      return { ...base, ...draft.budget };
    });
  }

  private buildChild(
    project: Project,
    rootId: string,
    id: string,
    draft: SubtaskDraft,
    budget: Budget,
    planId: string,
    policy: AcceptancePolicy,
    requestedProfile?: DeliverableProfile,
  ): TaskContract {
    const readOnly = this.isReadOnly(draft.role);
    const writeScope = (draft.writeScope ?? (readOnly ? [] : ['**'])).map((scope) =>
      relativeScope(project.path, scope),
    );
    const acceptanceDefaults = this.acceptanceDefaults(draft.role);
    return {
      task_id: id,
      parent_id: rootId,
      project_id: project.id,
      plan_id: planId,
      plan_revision: 1,
      delegated_by: 'planner',
      delegation_mode: 'fixed',
      title: draft.title,
      goal: draft.goal,
      inputs: draft.inputs,
      deliverables:
        draft.deliverables && draft.deliverables.length > 0
          ? draft.deliverables
          : defaultDeliverables(draft.role, writeScope[0]),
      constraints: draft.constraints ?? [],
      acceptance_criteria:
        draft.acceptance && draft.acceptance.length > 0
          ? draft.acceptance
          : acceptanceDefaults,
      acceptance_policy: draft.acceptancePolicy ?? policy,
      deliverable_profile:
        draft.deliverableProfile ??
        requestedProfile ??
        this.options.employees?.get(draft.role)?.deliverableProfile ??
        (draft.role === 'implementer' ? 'code' : 'document'),
      dependencies: [],
      write_scope: writeScope,
      assignee: {
        role: draft.role,
        runtime: this.options.runtime ?? 'mock',
        model: this.modelFor(draft.role),
      },
      budget,
      review: {
        required: draft.reviewRequired ?? draft.role !== 'verifier',
        reviewer_role: 'verifier',
      },
    };
  }

  /** 只读性优先来自员工插件包；未注册员工时退回内置角色约定。 */
  private isReadOnly(role: RoleName | undefined): boolean {
    if (!role) return false;
    const employee = this.options.employees?.get(role);
    if (employee) return employee.readOnly;
    return role === 'verifier' || role === 'researcher';
  }

  /** 默认验收标准来自员工插件包；未注册员工时退回最小 human 验收。 */
  private acceptanceDefaults(role: RoleName): AcceptanceCriterion[] {
    const employee = this.options.employees?.get(role);
    if (employee) return employee.acceptanceDefaults.map((criterion) => ({ ...criterion }));
    return [{ id: 'ac_human', type: 'human', desc: '用户确认结果' }];
  }

  private modelFor(role: RoleName): string {
    const override = this.options.model?.trim();
    if (override) return override;
    return (this.options.runtime ?? 'mock') === 'mock' ? `mock-${role}` : '';
  }

  private mergeDeliverables(children: TaskContract[]): Deliverable[] {
    const seen = new Set<string>();
    const result: Deliverable[] = [];
    for (const child of children) {
      for (const deliverable of child.deliverables) {
        const key = `${deliverable.type}:${deliverable.scope ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(deliverable);
      }
    }
    return result;
  }
}

/** 写域里的绝对路径换成项目相对路径：worktree 内的相对路径才能通过授权校验。 */
function relativeScope(root: string, scope: string): string {
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const target = scope.replaceAll('\\', '/');
  const baseLower = base.toLowerCase();
  const targetLower = target.toLowerCase();
  if (!baseLower) return scope;
  if (targetLower === baseLower) return '**';
  if (targetLower.startsWith(`${baseLower}/`)) {
    return target.slice(base.length + 1).replace(/^\/+/, '');
  }
  return scope;
}
