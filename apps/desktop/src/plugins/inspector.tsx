import { useEffect, useState } from 'react';
import type { ArtifactRecord, Assistant, EventRecord } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';
import {
  formatDateTime,
  formatMinutes,
  formatMoney,
  formatTime,
  MarkdownLite,
  ROLE_LABELS,
} from '../ui.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

function exportEvents(events: EventRecord[], projectId: string): void {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `opencoxswain-events-${projectId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function TimelineTab(): JSX.Element {
  const { events, tasks, project } = useWorkbench();
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  return (
    <div className="timeline-tab">
      <div className="row">
        <button
          className="ghost"
          onClick={() => exportEvents(events, project.id)}
          disabled={events.length === 0}
        >
          导出事件
        </button>
      </div>
      {events.length === 0 ? (
        <p className="placeholder">还没有事件。派单、工具调用、验收都会记录在这里。</p>
      ) : (
        <ol className="timeline">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <time>{formatTime(event.createdAt)}</time>
              <span className="event-type">{event.type}</span>
              <span className="event-task">
                {event.taskId ? taskTitles.get(event.taskId) ?? event.taskId : '项目'}
              </span>
              <details>
                <summary>详情</summary>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ArtifactsTab(): JSX.Element {
  const { artifacts, tasks } = useWorkbench();
  const [selected, setSelected] = useState<ArtifactRecord | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .artifact(selected.id)
      .then((text) => {
        if (alive) setContent(text);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  if (artifacts.length === 0) {
    return <p className="placeholder">员工完成后，diff 与报告会出现在这里。</p>;
  }

  return (
    <div className="artifacts">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button
            key={artifact.id}
            className={selected?.id === artifact.id ? 'artifact active' : 'artifact'}
            onClick={() => setSelected(artifact)}
          >
            <span className="artifact-type">{artifact.type}</span>
            <span className="artifact-name">{artifact.path.split(/[\\/]/).pop()}</span>
            <span className="artifact-task">{taskTitles.get(artifact.taskId) ?? ''}</span>
          </button>
        ))}
      </div>
      <div className="artifact-view">
        {!selected ? <p className="placeholder">选择左侧产物查看内容。</p> : null}
        {loading ? <p className="placeholder">读取中…</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {selected && !loading && !error ? (
          <>
            <header>
              <span>{selected.path}</span>
              <span className="muted">
                {formatDateTime(selected.createdAt)}
                {selected.meta
                  ? ` · ${selected.meta.files ?? 0} 文件 +${selected.meta.additions ?? 0} -${selected.meta.deletions ?? 0}`
                  : ''}
              </span>
            </header>
            <pre>{content}</pre>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SummaryTab(): JSX.Element {
  const { summary } = useWorkbench();
  return summary ? (
    <MarkdownLite text={summary} />
  ) : (
    <p className="placeholder">任务开始后在这里生成三块汇总。</p>
  );
}

function CostTab(): JSX.Element {
  const { workers, tasks, project } = useWorkbench();
  const totals = workers.reduce(
    (sum, worker) => ({
      usd: sum.usd + worker.cost.usd,
      tokensIn: sum.tokensIn + worker.cost.tokensIn,
      tokensOut: sum.tokensOut + worker.cost.tokensOut,
      minutes: sum.minutes + worker.cost.minutes,
    }),
    { usd: 0, tokensIn: 0, tokensOut: 0, minutes: 0 },
  );
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));

  return (
    <div className="cost">
      <div className="cost-summary">
        <div>
          <span>总花费</span>
          <strong>{formatMoney(totals.usd)}</strong>
        </div>
        <div>
          <span>输入 / 输出 tokens</span>
          <strong>
            {totals.tokensIn.toLocaleString()} / {totals.tokensOut.toLocaleString()}
          </strong>
        </div>
        <div>
          <span>总耗时</span>
          <strong>{formatMinutes(totals.minutes)}</strong>
        </div>
        <div>
          <span>项目日预算</span>
          <strong>{formatMoney(project.dailyBudgetUsd)}</strong>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>员工</th>
            <th>任务</th>
            <th>花费</th>
            <th>tokens</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {workers.map((worker) => (
            <tr key={worker.id}>
              <td>{ROLE_LABELS[worker.role]}</td>
              <td>{taskTitles.get(worker.taskId) ?? worker.taskId}</td>
              <td>{formatMoney(worker.cost.usd)}</td>
              <td>
                {worker.cost.tokensIn.toLocaleString()} / {worker.cost.tokensOut.toLocaleString()}
              </td>
              <td>{formatMinutes(worker.cost.minutes)}</td>
            </tr>
          ))}
          {workers.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                暂无花费记录
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function SettingsTab(): JSX.Element {
  const { project, assistant, busy, onProjectSettings, onAssistant } = useWorkbench();
  const [budget, setBudget] = useState(String(project.dailyBudgetUsd));
  const [concurrency, setConcurrency] = useState(String(project.maxConcurrency));
  const [name, setName] = useState(assistant.name);
  const [tone, setTone] = useState<Assistant['tone']>(assistant.tone);
  const [proactivity, setProactivity] = useState<Assistant['proactivity']>(assistant.proactivity);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBudget(String(project.dailyBudgetUsd));
    setConcurrency(String(project.maxConcurrency));
  }, [project.id, project.dailyBudgetUsd, project.maxConcurrency]);

  useEffect(() => {
    setName(assistant.name);
    setTone(assistant.tone);
    setProactivity(assistant.proactivity);
  }, [assistant.name, assistant.tone, assistant.proactivity]);

  const saveProject = async (): Promise<void> => {
    const usd = Number(budget);
    const max = Number(concurrency);
    if (!Number.isFinite(usd) || usd <= 0) {
      setNotice('日预算必须是正数');
      return;
    }
    if (!Number.isInteger(max) || max < 1 || max > 8) {
      setNotice('并发上限需为 1-8 的整数');
      return;
    }
    setNotice(null);
    try {
      await onProjectSettings({ dailyBudgetUsd: usd, maxConcurrency: max });
      setNotice('项目设置已保存');
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  const saveAssistant = async (): Promise<void> => {
    setNotice(null);
    try {
      await onAssistant({ name: name.trim() || assistant.name, tone, proactivity });
      setNotice('总管设置已保存');
    } catch (caught) {
      setNotice(errorText(caught));
    }
  };

  return (
    <div className="settings">
      <div className="settings-block">
        <h3>项目</h3>
        <p className="muted">{project.path}</p>
        <label>
          日预算（USD）
          <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          项目并发上限
          <input
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
            inputMode="numeric"
          />
        </label>
        <button disabled={busy} onClick={() => void saveProject()}>
          保存项目设置
        </button>
      </div>
      <div className="settings-block">
        <h3>总管</h3>
        <label>
          名字
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          语气
          <select value={tone} onChange={(event) => setTone(event.target.value as Assistant['tone'])}>
            <option value="concise">简洁</option>
            <option value="detailed">详细</option>
          </select>
        </label>
        <label>
          主动性
          <select
            value={proactivity}
            onChange={(event) => setProactivity(event.target.value as Assistant['proactivity'])}
          >
            <option value="ask_first">先问再做</option>
            <option value="act_first">先做再报</option>
          </select>
        </label>
        <button disabled={busy} onClick={() => void saveAssistant()}>
          保存总管设置
        </button>
      </div>
      {notice ? <p className="notice">{notice}</p> : null}
    </div>
  );
}

export const inspectorTabPlugins: UiPlugin[] = [
  { id: 'inspector.timeline', title: '时间线', slot: 'bottom', order: 10, render: TimelineTab },
  { id: 'inspector.artifacts', title: '产物', slot: 'bottom', order: 20, render: ArtifactsTab },
  { id: 'inspector.summary', title: '汇总', slot: 'bottom', order: 30, render: SummaryTab },
  { id: 'inspector.cost', title: '花费', slot: 'bottom', order: 40, render: CostTab },
  { id: 'inspector.settings', title: '设置', slot: 'bottom', order: 50, render: SettingsTab },
];
