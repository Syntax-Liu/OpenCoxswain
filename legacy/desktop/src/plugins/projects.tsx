import { useState } from 'react';
import type { RouteSuggestion } from '@opencoxswain/shared';
import { api, errorText } from '../api.js';
import { ProjectForm } from '../components/ProjectForm.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

/** 多项目：切换当前项目，或接入新的仓库；项目配置与任务树由 Daemon 按项目隔离。 */
function ProjectsPanel(): JSX.Element {
  const workbench = useWorkbench();
  const [adding, setAdding] = useState(false);
  const [goal, setGoal] = useState('');
  const [suggestions, setSuggestions] = useState<RouteSuggestion[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const route = async (): Promise<void> => {
    const text = goal.trim();
    if (text === '') {
      setNote('先写一句要做的事');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await api.routeGoal(text);
      setSuggestions(result.suggestions);
      if (result.suggestions.length === 0) {
        setNote('没有匹配的项目，可以手动选择或接入新项目。');
      }
    } catch (caught) {
      setNote(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const plan = async (suggestion: RouteSuggestion): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await api.createPlan(suggestion.projectId, goal.trim());
      setSuggestions(null);
      setGoal('');
      setNote(`已在「${suggestion.projectName}」生成任务单，等你确认开工。`);
      if (suggestion.projectId !== workbench.project.id) {
        workbench.onSwitchProject(suggestion.projectId);
      }
    } catch (caught) {
      setNote(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel projects">
      <div className="panel-body">
        <div className="row end">
          <button className="ghost" onClick={() => setAdding((value) => !value)}>
            {adding ? '收起' : '接入新项目'}
          </button>
        </div>
        <select
          value={workbench.project.id}
          onChange={(event) => workbench.onSwitchProject(event.target.value)}
          aria-label="切换项目"
        >
          {workbench.snapshot.projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <p className="hint path" title={workbench.project.path}>
          {workbench.project.path}
        </p>
        <dl className="inline-facts">
          <div>
            <dt>日预算</dt>
            <dd>${workbench.project.dailyBudgetUsd.toFixed(2)}</dd>
          </div>
          <div>
            <dt>并发上限</dt>
            <dd>{workbench.project.maxConcurrency}</dd>
          </div>
        </dl>
        {adding ? (
          <ProjectForm
            submitLabel="接入并切换"
            busyLabel="接入中…"
            onReady={(project) => {
              setAdding(false);
              workbench.onProjectReady(project);
            }}
          />
        ) : null}
        <div className="route-block">
          <label>
            全局派活
            <input
              value={goal}
              placeholder="一句话描述要做的事"
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void route();
              }}
            />
          </label>
          <button className="ghost" disabled={busy} onClick={() => void route()}>
            {busy ? '匹配中…' : '找项目'}
          </button>
          {note ? <p className="hint">{note}</p> : null}
          {suggestions && suggestions.length > 0 ? (
            <ul className="route-list">
              {suggestions.map((item) => (
                <li key={item.projectId}>
                  <div className="row">
                    <strong>{item.projectName}</strong>
                    <button
                      className="ghost"
                      disabled={busy}
                      onClick={() => void plan(item)}
                    >
                      生成任务单
                    </button>
                  </div>
                  <p className="hint">{item.reasons.join('，')}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="hint">
            只给建议；生成的任务单仍要你确认开工，当前项目有未完成任务时会拒绝建单。
          </p>
        </div>
      </div>
    </section>
  );
}

export const projectsPlugin: UiPlugin = {
  id: 'page.projects',
  title: '项目',
  slot: 'page',
  order: 90,
  render: ProjectsPanel,
};
