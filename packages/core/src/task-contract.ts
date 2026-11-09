import {
  ACCEPTANCE_POLICIES,
  ACCEPTANCE_TYPES,
  DELIVERABLE_PROFILES,
  DELIVERABLE_TYPES,
  EVIDENCE_KINDS,
  ROLE_NAMES,
  type AcceptanceCriterion,
  type Budget,
  type Deliverable,
  type TaskContract,
} from '@opencoxswain/shared';

export type TaskContractValidation =
  | { ok: true; value: TaskContract }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateDeliverables(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('deliverables 必须是非空数组');
    return;
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`deliverables[${index}] 必须是对象`);
      return;
    }
    if (!DELIVERABLE_TYPES.includes(item.type as Deliverable['type'])) {
      errors.push(`deliverables[${index}].type 非法`);
    }
    if (item.scope !== undefined && typeof item.scope !== 'string') {
      errors.push(`deliverables[${index}].scope 必须是字符串`);
    }
  });
}

function validateAcceptance(value: unknown, errors: string[], allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push('acceptance_criteria 必须是非空数组');
    return;
  }
  if (allowEmpty && Array.isArray(value) && value.length === 0) return;
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`acceptance_criteria[${index}] 必须是对象`);
      return;
    }
    const criterion = item as Partial<AcceptanceCriterion>;
    if (!isNonEmptyString(criterion.id)) {
      errors.push(`acceptance_criteria[${index}].id 必须是非空字符串`);
    } else if (seen.has(criterion.id)) {
      errors.push(`acceptance_criteria id 重复：${criterion.id}`);
    } else {
      seen.add(criterion.id);
    }
    if (!ACCEPTANCE_TYPES.includes(criterion.type as AcceptanceCriterion['type'])) {
      errors.push(`acceptance_criteria[${index}].type 非法`);
    }
    if (!isNonEmptyString(criterion.desc)) {
      errors.push(`acceptance_criteria[${index}].desc 必须是非空字符串`);
    }
    if (criterion.type === 'command' && !isNonEmptyString(criterion.check)) {
      errors.push(`acceptance_criteria[${index}] 是 command 类型，必须提供 check`);
    }
    if (criterion.check !== undefined && typeof criterion.check !== 'string') {
      errors.push(`acceptance_criteria[${index}].check 必须是字符串`);
    }
    if (criterion.evidence_required !== undefined) {
      if (!Array.isArray(criterion.evidence_required)) {
        errors.push(`acceptance_criteria[${index}].evidence_required 必须是数组`);
      } else {
        for (const kind of criterion.evidence_required) {
          if (!EVIDENCE_KINDS.includes(kind as never)) {
            errors.push(`acceptance_criteria[${index}].evidence_required 含非法证据类型`);
          }
        }
      }
    }
  });
}

function validateBudget(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('budget 必须是对象');
    return;
  }
  const budget = value as Budget;
  const fields = ['tokens', 'usd', 'minutes'] as const;
  let positive = 0;
  for (const field of fields) {
    const limit = budget[field];
    if (limit === undefined) continue;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      errors.push(`budget.${field} 必须是正数`);
    } else {
      positive += 1;
    }
  }
  if (positive === 0) {
    errors.push('budget 至少需要 tokens / usd / minutes 中的一项');
  }
}

/** 按 PRD 附录 A 校验任务单；缺字段不允许进入执行。 */
export function validateTaskContract(value: unknown): TaskContractValidation {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ['任务单必须是 JSON 对象'] };
  }

  for (const field of ['task_id', 'project_id', 'title', 'goal'] as const) {
    if (!isNonEmptyString(value[field])) {
      errors.push(`${field} 必须是非空字符串`);
    }
  }
  if (value.parent_id !== null && typeof value.parent_id !== 'string') {
    errors.push('parent_id 必须是字符串或 null');
  }
  if (value.context_refs !== undefined && !isStringArray(value.context_refs)) {
    errors.push('context_refs 必须是字符串数组');
  }
  if (value.inputs !== undefined && !isRecord(value.inputs)) {
    errors.push('inputs 必须是对象');
  }
  if (value.constraints !== undefined && !isStringArray(value.constraints)) {
    errors.push('constraints 必须是字符串数组');
  }
  if (!isStringArray(value.dependencies)) {
    errors.push('dependencies 必须是字符串数组');
  }
  if (value.write_scope !== undefined && !isStringArray(value.write_scope)) {
    errors.push('write_scope 必须是字符串数组');
  }
  if (value.deadline !== undefined && typeof value.deadline !== 'string') {
    errors.push('deadline 必须是字符串');
  }
  if (
    value.acceptance_policy !== undefined &&
    !ACCEPTANCE_POLICIES.includes(value.acceptance_policy as never)
  ) {
    errors.push('acceptance_policy 非法');
  }
  if (
    value.deliverable_profile !== undefined &&
    !DELIVERABLE_PROFILES.includes(value.deliverable_profile as never)
  ) {
    errors.push('deliverable_profile 非法');
  }

  validateDeliverables(value.deliverables, errors);
  validateAcceptance(value.acceptance_criteria, errors, value.parent_id === null);
  validateBudget(value.budget, errors);

  if (value.assignee !== undefined) {
    if (!isRecord(value.assignee)) {
      errors.push('assignee 必须是对象');
    } else {
      if (!ROLE_NAMES.includes(value.assignee.role as never)) {
        errors.push('assignee.role 非法');
      }
      if (!isNonEmptyString(value.assignee.runtime)) {
        errors.push('assignee.runtime 必须是非空字符串');
      }
      if (!isNonEmptyString(value.assignee.model)) {
        errors.push('assignee.model 必须是非空字符串');
      }
    }
  }

  if (value.review !== undefined) {
    if (!isRecord(value.review) || typeof value.review.required !== 'boolean') {
      errors.push('review 必须是包含 required 布尔值的对象');
    } else if (
      value.review.reviewer_role !== undefined &&
      !ROLE_NAMES.includes(value.review.reviewer_role as never)
    ) {
      errors.push('review.reviewer_role 非法');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: value as unknown as TaskContract };
}
