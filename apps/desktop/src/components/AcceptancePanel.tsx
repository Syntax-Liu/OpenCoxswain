import { useState } from 'react';
import type {
  AcceptanceDecision,
  AcceptanceRecord,
  DecisionBrief,
  Evidence,
  Task,
} from '@opencoxswain/shared';

interface Props {
  task: Task;
  brief: DecisionBrief | null;
  records: AcceptanceRecord[];
  evidence: Evidence[];
  busy: boolean;
  onSubmit: (decisions: AcceptanceDecision[]) => void;
}

interface Draft {
  verdict?: 'passed' | 'failed';
  note: string;
}

const BRIEF_SECTIONS: Array<{ key: keyof DecisionBrief; label: string }> = [
  { key: 'changed', label: '改了什么' },
  { key: 'why', label: '为什么' },
  { key: 'verified', label: '验过什么' },
  { key: 'risks', label: '还有什么风险' },
];

/**
 * 验收决策说明 + 逐条验收。
 * 四段说明由系统按契约与复核结果生成；证据默认折叠，避免盖过结论。
 */
export function AcceptancePanel({
  task,
  brief,
  records,
  evidence,
  busy,
  onSubmit,
}: Props): JSX.Element | null {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);

  const byKey = new Map(records.map((record) => [record.criterionId, record]));
  const pending = task.contract.acceptance_criteria.filter(
    (criterion) => byKey.get(criterion.id)?.verdict !== 'passed',
  );
  if (pending.length === 0) return null;

  const patch = (key: string, next: Partial<Draft>): void => {
    setDrafts((previous) => ({
      ...previous,
      [key]: { ...(previous[key] ?? { note: '' }), ...next },
    }));
  };

  const submit = (): void => {
    const decisions: AcceptanceDecision[] = [];
    for (const criterion of pending) {
      const draft = drafts[criterion.id];
      if (!draft?.verdict) {
        setError(`请先为「${criterion.desc}」选择结论`);
        return;
      }
      if (!draft.note.trim()) {
        setError(`请填写「${criterion.desc}」的判断理由`);
        return;
      }
      decisions.push({ criterionId: criterion.id, verdict: draft.verdict, note: draft.note.trim() });
    }
    setError(null);
    onSubmit(decisions);
  };

  return (
    <section className="acceptance-panel">
      <header className="panel-subheader">
        <h3>验收决策</h3>
        <span className="count">{pending.length}</span>
      </header>
      <article className="decision-brief">
        <h4>{task.parentId === null ? '交付说明' : `子任务：${task.title}`}</h4>
        {brief ? (
          <>
            <dl>
              {BRIEF_SECTIONS.map((section) => (
                <div key={section.key}>
                  <dt>{section.label}</dt>
                  <dd>{String(brief[section.key] ?? '') || '—'}</dd>
                </div>
              ))}
            </dl>
            {brief.conflictReason ? (
              <p className="hint danger-text">冲突判定：{brief.conflictReason}</p>
            ) : null}
          </>
        ) : (
          <p className="hint">系统还没有生成决策说明；提交验收前会再校验一次。</p>
        )}
        <p className="hint">
          证据由系统复核（命令重跑、diff 复算）；员工自述只作参考，不能替代系统验证。
        </p>
      </article>
      {pending.map((criterion) => {
        const draft = drafts[criterion.id] ?? { note: '' };
        const record = byKey.get(criterion.id);
        const items = evidence.filter(
          (entry) => entry.taskId === task.id && entry.criterionId === criterion.id,
        );
        return (
          <article className="acceptance-row" key={criterion.id}>
            <header>
              <strong>{criterion.id}</strong>
              <span className="role-tag">{criterion.type}</span>
            </header>
            <p className="goal">{criterion.desc}</p>
            {record && record.verdict !== 'passed' ? (
              <p className="hint">
                系统结论：{record.verdict === 'failed' ? '未通过' : '未验证'}
                {record.note ? ` · ${record.note}` : ''}
              </p>
            ) : null}
            {items.length > 0 ? (
              <details className="evidence-fold">
                <summary>系统证据（{items.length}）</summary>
                <ul className="evidence-list">
                  {items.map((entry) => (
                    <li key={entry.id} title={entry.ref}>
                      {entry.kind}：{entry.digest}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="hint">这项还没有系统证据。</p>
            )}
            <div className="row wrap">
              <button
                className={draft.verdict === 'passed' ? 'primary' : 'ghost'}
                onClick={() => patch(criterion.id, { verdict: 'passed' })}
              >
                通过
              </button>
              <button
                className={draft.verdict === 'failed' ? 'danger' : 'ghost'}
                onClick={() => patch(criterion.id, { verdict: 'failed' })}
              >
                不通过
              </button>
            </div>
            <textarea
              rows={2}
              placeholder="判断理由（必填）"
              value={draft.note}
              onChange={(event) => patch(criterion.id, { note: event.target.value })}
            />
          </article>
        );
      })}
      {error ? <p className="hint danger-text">{error}</p> : null}
      <button className="primary" disabled={busy} onClick={submit}>
        提交验收
      </button>
    </section>
  );
}
