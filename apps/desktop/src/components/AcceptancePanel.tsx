import { useState } from 'react';
import type {
  AcceptanceCriterion,
  AcceptanceDecision,
  AcceptanceRecord,
  Evidence,
  Task,
} from '@opencoxswain/shared';

interface Props {
  tasks: Task[];
  records: AcceptanceRecord[];
  evidence: Evidence[];
  busy: boolean;
  onSubmit: (decisions: AcceptanceDecision[]) => void;
}

interface Draft {
  verdict?: 'passed' | 'failed';
  note: string;
}

interface PendingItem {
  key: string;
  task: Task;
  criterion: AcceptanceCriterion;
  record?: AcceptanceRecord;
}

/**
 * 逐条验收：每条未通过的验收项都要单独给结论和理由，
 * 系统已复核的证据只展示、不覆盖。
 */
export function AcceptancePanel({ tasks, records, evidence, busy, onSubmit }: Props): JSX.Element | null {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);

  const byKey = new Map(records.map((record) => [`${record.taskId}:${record.criterionId}`, record]));
  const pending: PendingItem[] = [];
  for (const task of tasks) {
    for (const criterion of task.contract.acceptance_criteria) {
      const key = `${task.id}:${criterion.id}`;
      const record = byKey.get(key);
      if (record?.verdict === 'passed') continue;
      pending.push({ key, task, criterion, record });
    }
  }
  if (pending.length === 0) return null;

  const patch = (key: string, next: Partial<Draft>): void => {
    setDrafts((previous) => ({
      ...previous,
      [key]: { ...(previous[key] ?? { note: '' }), ...next },
    }));
  };

  const submit = (): void => {
    const decisions: AcceptanceDecision[] = [];
    for (const item of pending) {
      const draft = drafts[item.key];
      if (!draft?.verdict) {
        setError(`请先为「${item.criterion.desc}」选择结论`);
        return;
      }
      if (!draft.note.trim()) {
        setError(`请填写「${item.criterion.desc}」的判断理由`);
        return;
      }
      decisions.push({ criterionId: item.key, verdict: draft.verdict, note: draft.note.trim() });
    }
    setError(null);
    onSubmit(decisions);
  };

  return (
    <section className="acceptance-panel">
      <header className="panel-subheader">
        <h3>逐条验收</h3>
        <span className="count">{pending.length}</span>
      </header>
      {pending.map((item) => {
        const draft = drafts[item.key] ?? { note: '' };
        const items = evidence.filter(
          (entry) => entry.taskId === item.task.id && entry.criterionId === item.criterion.id,
        );
        return (
          <article className="acceptance-row" key={item.key}>
            <header>
              <strong>{item.criterion.id}</strong>
              <span className="role-tag">{item.criterion.type}</span>
              {item.task.parentId !== null ? <small>{item.task.title}</small> : null}
            </header>
            <p className="goal">{item.criterion.desc}</p>
            {item.record && item.record.verdict !== 'passed' ? (
              <p className="hint">
                系统结论：{item.record.verdict === 'failed' ? '未通过' : '未验证'}
                {item.record.note ? ` · ${item.record.note}` : ''}
              </p>
            ) : null}
            {items.length > 0 ? (
              <ul className="evidence-list">
                {items.map((entry) => (
                  <li key={entry.id} title={entry.ref}>
                    {entry.kind}：{entry.digest}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="row wrap">
              <button
                className={draft.verdict === 'passed' ? 'primary' : 'ghost'}
                onClick={() => patch(item.key, { verdict: 'passed' })}
              >
                通过
              </button>
              <button
                className={draft.verdict === 'failed' ? 'danger' : 'ghost'}
                onClick={() => patch(item.key, { verdict: 'failed' })}
              >
                不通过
              </button>
            </div>
            <textarea
              rows={2}
              placeholder="判断理由（必填）"
              value={draft.note}
              onChange={(event) => patch(item.key, { note: event.target.value })}
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
