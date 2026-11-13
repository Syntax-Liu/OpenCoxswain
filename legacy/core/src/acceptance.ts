import type {
  AcceptanceCriterion,
  AcceptanceRecord,
  Evidence,
  EvidenceKind,
  Verdict,
} from '@opencoxswain/shared';

/** 按验收类型推导最小证据集：command 自动跑、human 只需一句理由。 */
export function requiredEvidenceFor(type: AcceptanceCriterion['type']): EvidenceKind[] {
  switch (type) {
    case 'command':
      return ['command_output'];
    case 'diff':
      return ['diff_stat'];
    case 'rubric':
      return ['link'];
    case 'human':
      return ['human_note'];
  }
}

export function requiredEvidence(criterion: AcceptanceCriterion): EvidenceKind[] {
  return criterion.evidence_required ?? requiredEvidenceFor(criterion.type);
}

/** 返回缺失的证据类型（空数组表示满足）。 */
export function missingEvidence(criterion: AcceptanceCriterion, evidence: Evidence[]): EvidenceKind[] {
  const present = new Set(evidence.filter((item) => item.criterionId === criterion.id).map((item) => item.kind));
  return requiredEvidence(criterion).filter((kind) => !present.has(kind));
}

/**
 * 只依据证据推导结论。执行者自报不被采信，因此这里不接收 worker 结果。
 * - 缺证据 → unverified
 * - 证据摘要以 `exit:` 开头且非 0 → failed（command）
 * - 其余有证据 → passed
 */
export function deriveVerdict(
  criterion: AcceptanceCriterion,
  evidence: Evidence[],
): { verdict: Verdict; note?: string } {
  const items = evidence.filter((item) => item.criterionId === criterion.id);
  const missing = missingEvidence(criterion, items);
  if (missing.length > 0) return { verdict: 'unverified', note: `缺少证据：${missing.join('、')}` };
  const failed = items.find((item) => item.kind === 'command_output' && /^exit:[1-9]/.test(item.digest));
  if (failed) return { verdict: 'failed', note: `命令退出码非 0：${failed.digest}` };
  return { verdict: 'passed' };
}

/** 汇总一条任务树的判定：任一失败 → failed；全通过 → passed；否则 unverified。 */
export function combineVerdicts(records: AcceptanceRecord[]): Verdict {
  if (records.some((record) => record.verdict === 'failed')) return 'failed';
  if (records.length > 0 && records.every((record) => record.verdict === 'passed')) return 'passed';
  return 'unverified';
}
