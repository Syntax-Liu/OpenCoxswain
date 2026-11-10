import { useState } from 'react';
import { ProjectForm } from '../components/ProjectForm.js';
import { useWorkbench } from '../workbench.js';
import type { UiPlugin } from './registry.js';

/** 多项目：切换当前项目，或接入新的仓库；项目配置与任务树由 Daemon 按项目隔离。 */
function ProjectsPanel(): JSX.Element {
  const workbench = useWorkbench();
  const [adding, setAdding] = useState(false);

  return (
    <section className="panel projects">
      <header className="panel-header">
        <h2>项目</h2>
        <button className="ghost" onClick={() => setAdding((value) => !value)}>
          {adding ? '收起' : '接入新项目'}
        </button>
      </header>
      <div className="panel-body">
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
      </div>
    </section>
  );
}

export const projectsPlugin: UiPlugin = {
  id: 'panel.projects',
  title: '项目',
  slot: 'left',
  order: 3,
  render: ProjectsPanel,
};
