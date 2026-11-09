import type {
  AcceptanceResult,
  Approval,
  ArtifactRef,
  CostLedger,
  TaskContract,
  TaskStatus,
} from '@opencoxswain/shared';

export interface SummaryInput {
  contract: TaskContract;
  status: TaskStatus;
  acceptance: AcceptanceResult[];
  artifacts: ArtifactRef[];
  cost: CostLedger;
  branch?: string;
  approvals?: Approval[];
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** 任务结束时的固定三块汇总；不允许只回“完成了”。 */
export function buildSummary(input: SummaryInput): string {
  const byId = new Map(input.acceptance.map((result) => [result.criterionId, result]));
  const decisions: string[] = [];
  const failures: string[] = [];

  for (const criterion of input.contract.acceptance_criteria) {
    const result = byId.get(criterion.id);
    if (criterion.type === 'human' && (result === undefined || result.status === 'unverified')) {
      decisions.push(`- [ ] ${criterion.id}：${criterion.desc}（需要你确认）`);
      continue;
    }
    if (result?.status === 'failed') {
      failures.push(
        `- [x] ${criterion.id}：${criterion.desc}（证据：${result.evidence ?? '未提供'}）`,
      );
    } else if (result?.status === 'unverified') {
      failures.push(`- [!] ${criterion.id}：${criterion.desc}（尚未验证）`);
    }
  }

  for (const approval of input.approvals ?? []) {
    if (approval.status !== 'pending') continue;
    const payload = approval.payload as { question?: string } | null;
    decisions.push(`- [ ] 审批 ${approval.type}：${payload?.question ?? '等待你确认'}`);
  }

  const artifacts: string[] = [];
  if (input.branch) {
    artifacts.push(`- 分支：${input.branch}`);
  }
  for (const artifact of input.artifacts) {
    const meta = artifact.meta;
    const stats =
      meta && (meta.files !== undefined || meta.additions !== undefined)
        ? `（${meta.files ?? 0} 个文件，+${meta.additions ?? 0} / -${meta.deletions ?? 0}）`
        : '';
    artifacts.push(`- ${artifact.type}：${artifact.path}${stats}`);
  }
  const budgetUsd = input.contract.budget.usd;
  const costLine =
    budgetUsd === undefined
      ? `- 花费：${money(input.cost.usd)}；tokens ${input.cost.tokensIn + input.cost.tokensOut}`
      : `- 花费：${money(input.cost.usd)} / 预算 ${money(budgetUsd)}；tokens ${input.cost.tokensIn + input.cost.tokensOut}`;
  artifacts.push(costLine);

  return [
    '## 待你决策',
    decisions.length > 0 ? decisions.join('\n') : '- 无',
    '',
    '## 未通过的检查',
    failures.length > 0 ? failures.join('\n') : '- 无',
    '',
    '## 交付产物',
    artifacts.join('\n'),
  ].join('\n');
}
