import type {
  AcceptanceDecision,
  AcceptanceRecord,
  Evidence,
  Task,
  TaskEdge,
  TaskStage,
  TaskStageView,
} from '@opencoxswain/shared';
import type { TaskAction } from '../api.js';
import { ROLE_LABELS, StatusChip } from '../ui.js';
import { AcceptancePanel } from './AcceptancePanel.js';

interface Props {
  root: Task | null;
  children: Task[];
  edges: TaskEdge[];
  records: AcceptanceRecord[];
  evidence: Evidence[];
  stages: TaskStageView[];
  busy: boolean;
  onAction: (action: TaskAction) => void;
  onAcceptance: (decisions: AcceptanceDecision[]) => void;
}

const STAGE_LABELS: Record<TaskStage['kind'], string> = {
  person: '等你处理',
  working: '执行中',
  idle: '等待中',
};

function stageText(stage: TaskStage | undefined): string {
  if (!stage) return '';
  switch (stage.kind) {
    case 'person':
      return stage.reason === 'review' ? '等你验收' : '等你处理';
    case 'working':
      return stage.reason === 'running' ? '执行中' : '排队中';
    case 'idle':
      return stage.reason === 'waiting_dependency' ? '等依赖' : '等待中';
  }
}

export function TaskTree({
  root,
  children,
  edges,
  records,
  evidence,
  stages,
  busy,
  onAction,
  onAcceptance,
}: Props): JSX.Element {
  if (!root) {
    return (
      <section className="panel task-tree">
        <header className="panel-header">
          <h2>任务树</h2>
        </header>
        <div className="panel-body">
          <p className="placeholder">还没有任务。先在中间对总管描述目标。</p>
        </div>
      </section>
    );
  }

  const titleOf = new Map<string, string>();
  for (const task of [root, ...children]) titleOf.set(task.id, task.title);

  const stageOf = new Map(stages.map((view) => [view.taskId, view.stage]));
  const canCancel = !['done', 'cancelled'].includes(root.status);
  const actions: Array<{ action: TaskAction; label: string; kind?: string }> = [];
  if (root.status === 'awaiting_approval') {
    actions.push({ action: 'approve', label: '确认开工', kind: 'primary' });
    actions.push({ action: 'reject', label: '打回' });
  }
  if (root.status === 'running' || root.status === 'queued') {
    actions.push({ action: 'pause', label: '暂停' });
  }
  if (root.status === 'paused') {
    actions.push({ action: 'resume', label: '继续' });
  }
  if (canCancel) actions.push({ action: 'cancel', label: '终止', kind: 'danger' });

  return (
    <section className="panel task-tree">
      <header className="panel-header">
        <h2>任务树</h2>
        <span className="stage-label" data-stage={stageOf.get(root.id)?.kind}>
          {stageText(stageOf.get(root.id))}
        </span>
        <StatusChip status={root.status} />
      </header>
      <div className="panel-body">
        <article className="task-card root-task">
          <h3>{root.title}</h3>
          <p className="goal">{root.goal}</p>
          <dl className="facts">
            <div>
              <dt>预算</dt>
              <dd>
                ${(root.contract.budget.usd ?? 0).toFixed(2)} ·{' '}
                {(root.contract.budget.tokens ?? 0).toLocaleString()} tokens
              </dd>
            </div>
            <div>
              <dt>验收</dt>
              <dd>{root.contract.acceptance_criteria.map((item) => item.desc).join('；')}</dd>
            </div>
          </dl>
          {actions.length > 0 ? (
            <div className="row wrap">
              {actions.map((item) => (
                <button
                  key={item.action}
                  className={item.kind}
                  disabled={busy}
                  onClick={() => onAction(item.action)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </article>

        <div className="subtasks">
          {children.map((task, index) => {
            const deps = edges
              .filter((edge) => edge.toTaskId === task.id)
              .map((edge) => titleOf.get(edge.fromTaskId) ?? edge.fromTaskId);
            return (
              <article className="task-card subtask" key={task.id}>
                <header>
                  <span className="index">{String(index + 1).padStart(2, '0')}</span>
                  <h4>{task.title}</h4>
                  <span className="stage-label">{stageText(stageOf.get(task.id))}</span>
                  <StatusChip status={task.status} />
                </header>
                <p className="goal">{task.goal}</p>
                <dl className="facts">
                  <div>
                    <dt>角色</dt>
                    <dd>{task.contract.assignee ? ROLE_LABELS[task.contract.assignee.role] : '—'}</dd>
                  </div>
                  <div>
                    <dt>写域</dt>
                    <dd>{(task.contract.write_scope ?? []).join('、') || '只读'}</dd>
                  </div>
                  {deps.length > 0 ? (
                    <div>
                      <dt>依赖</dt>
                      <dd>{deps.join('、')}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>验收</dt>
                    <dd>{task.contract.acceptance_criteria.map((item) => item.type).join(' / ')}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>

        {root.status === 'awaiting_review' ? (
          <AcceptancePanel
            tasks={[root, ...children]}
            records={records}
            evidence={evidence}
            busy={busy}
            onSubmit={onAcceptance}
          />
        ) : null}
      </div>
    </section>
  );
}
