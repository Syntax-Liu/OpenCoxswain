import {
  newId,
  type AcceptanceCriterion,
  type Budget,
  type CreatePlanRequest,
  type Deliverable,
  type Project,
  type RoleName,
  type SubtaskDraft,
  type TaskContract,
} from '@opencoxswain/shared';
import { sumBudgets, validateDag, validateTaskContract } from '@opencoxswain/core';

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

function shortTitle(goal: string): string {
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

export class Planner {
  plan(project: Project, request: CreatePlanRequest): PlanResult {
    const goal = request.goal?.trim();
    if (!goal) throw new Error('goal 不能为空');

    const drafts = request.subtasks && request.subtasks.length > 0
      ? request.subtasks
      : this.defaultDrafts(request);
    if (drafts.length < 2 || drafts.length > 5) {
      throw new Error('子任务数量需在 2-5 之间');
    }

    const rootId = newId('tsk');
    const ids = drafts.map(() => newId('tsk'));
    const budgets = this.splitBudget(request.budget ?? DEFAULT_BUDGET, drafts);
    const children = drafts.map((draft, index) =>
      this.buildChild(project, rootId, ids[index]!, draft, budgets[index]!),
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
        readOnly: child.assignee?.role === 'verifier' || child.assignee?.role === 'researcher',
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
      title: shortTitle(goal),
      goal,
      deliverables: this.mergeDeliverables(children),
      constraints: [],
      acceptance_criteria: [
        { id: 'human_accept', type: 'human', desc: '用户验收通过' },
      ],
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
    const implementerAcceptance: AcceptanceCriterion[] = [];
    const verifierAcceptance: AcceptanceCriterion[] = [];
    if (request.acceptanceCommand) {
      implementerAcceptance.push({
        id: 'ac1',
        type: 'command',
        desc: '验收命令通过',
        check: request.acceptanceCommand,
      });
      verifierAcceptance.push({
        id: 'ac1',
        type: 'command',
        desc: '独立复跑验收命令',
        check: request.acceptanceCommand,
      });
    }
    implementerAcceptance.push({
      id: 'ac_human',
      type: 'human',
      desc: '用户确认改动符合目标',
    });
    verifierAcceptance.push(
      { id: 'ac_rubric', type: 'rubric', desc: '独立检查 diff 是否符合目标' },
      { id: 'ac_human', type: 'human', desc: '用户确认校验结论' },
    );

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
  ): TaskContract {
    const writeScope =
      draft.writeScope ?? (draft.role === 'verifier' || draft.role === 'researcher' ? [] : ['**']);
    return {
      task_id: id,
      parent_id: rootId,
      project_id: project.id,
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
          : [{ id: 'ac_human', type: 'human', desc: '用户确认结果' }],
      dependencies: [],
      write_scope: writeScope,
      assignee: {
        role: draft.role,
        runtime: 'mock',
        model: `mock-${draft.role}`,
      },
      budget,
      review: {
        required: draft.reviewRequired ?? draft.role !== 'verifier',
        reviewer_role: 'verifier',
      },
    };
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
