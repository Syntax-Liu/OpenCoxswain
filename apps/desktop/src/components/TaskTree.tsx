import { useState } from 'react';
import {
  ROLE_NAMES,
  type AcceptanceDecision,
  type AcceptanceRecord,
  type DecisionBrief,
  type Evidence,
  type RoleName,
  type Task,
  type TaskEdge,
  type TaskInput,
  type TaskStage,
  type TaskStageView,
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
  inputs: TaskInput[];
  reviewTask: Task | null;
  brief: DecisionBrief | null;
  busy: boolean;
  onAction: (action: TaskAction) => void;
  onAcceptance: (decisions: AcceptanceDecision[]) => void;
  onReview: (taskId: string) => void;
  onInput: (taskId: string, text: string) => void;
  onReassign: (taskId: string, role: RoleName) => void;
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

const INPUT_STATE_LABELS: Record<TaskInput['state'], string> = {
  pending: '待送达',
  delivered: '已送达',
  queued: '已排队',
  consumed: '已接收',
  rejected: '被拒绝',
};

function InputBox({
  taskId,
  busy,
  onSend,
}: {
  taskId: string;
  busy: boolean;
  onSend: (taskId: string, text: string) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  return (
    <form
      className="row wrap input-row"
      onSubmit={(event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value) return;
        onSend(taskId, value);
        setText('');
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="给员工发中途消息（不打断执行）"
        disabled={busy}
      />
      <button type="submit" disabled={busy || !text.trim()}>
        发送
      </button>
    </form>
  );
}

function latestInput(inputs: TaskInput[], taskId: string): TaskInput | null {
  return inputs.filter((input) => input.taskId === taskId).at(-1) ?? null;
}

/** 任务依赖图：按拓扑深度分层，只做可视化，不改变调度。 */
function DagView({ tasks, edges }: { tasks: Task[]; edges: TaskEdge[] }): JSX.Element | null {
  if (tasks.length < 2) return null;
  const ids = new Set(tasks.map((task) => task.id));
  const depth = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = edges.filter((edge) => edge.toTaskId === id && ids.has(edge.fromTaskId));
    const value =
      deps.length === 0 ? 0 : Math.max(...deps.map((edge) => visit(edge.fromTaskId, new Set(seen)) + 1));
    depth.set(id, value);
    return value;
  };
  for (const task of tasks) visit(task.id, new Set());
  const layers: Task[][] = [];
  for (const task of tasks) {
    const level = depth.get(task.id) ?? 0;
    (layers[level] ??= []).push(task);
  }
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return (
    <div className="dag">
      <p className="hint">依赖图：自上而下分层，同层可并行。</p>
      {layers.map((layer, level) => (
        <div className="dag-level" key={level}>
          {level > 0 ? <span className="dag-arrow">↓</span> : null}
          <div className="dag-layer">
            {layer.map((task) => {
              const deps = edges
                .filter((edge) => edge.toTaskId === task.id && ids.has(edge.fromTaskId))
                .map((edge) => titles.get(edge.fromTaskId))
                .filter(Boolean)
                .join('、');
              return (
                <span
                  key={task.id}
                  className={`dag-node status-${task.status}`}
                  title={deps ? `依赖：${deps}` : '无依赖'}
                >
                  {task.title}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReassignBox({
  task,
  busy,
  onReassign,
}: {
  task: Task;
  busy: boolean;
  onReassign: (taskId: string, role: RoleName) => void;
}): JSX.Element {
  const [role, setRole] = useState<RoleName>(task.contract.assignee?.role ?? 'implementer');
  return (
    <div className="row wrap reassign">
      <select
        value={role}
        disabled={busy}
        onChange={(event) => setRole(event.target.value as RoleName)}
      >
        {ROLE_NAMES.map((name) => (
          <option key={name} value={name}>
            {ROLE_LABELS[name]}
          </option>
        ))}
      </select>
      <button disabled={busy} onClick={() => onReassign(task.id, role)}>
        重派
      </button>
      <span className="hint">仅清理 worktree 后重新执行，不做文件级回滚。</span>
    </div>
  );
}

export function TaskTree({
  root,
  children,
  edges,
  records,
  evidence,
  stages,
  inputs,
  reviewTask,
  brief,
  busy,
  onAction,
  onAcceptance,
  onReview,
  onInput,
  onReassign,
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
          {root.status === 'running' ? (
            <InputBox taskId={root.id} busy={busy} onSend={onInput} />
          ) : null}
          {latestInput(inputs, root.id) ? (
            <p className="hint">
              最近消息：{latestInput(inputs, root.id)?.text}（
              {INPUT_STATE_LABELS[latestInput(inputs, root.id)!.state]}）
            </p>
          ) : null}
        </article>

        <DagView tasks={children} edges={edges} />

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
                {task.status === 'running' ? (
                  <InputBox taskId={task.id} busy={busy} onSend={onInput} />
                ) : null}
                {task.status === 'awaiting_review' ? (
                  <div className="row">
                    <button className="primary" disabled={busy} onClick={() => onReview(task.id)}>
                      单独验收
                    </button>
                  </div>
                ) : null}
                {task.status === 'failed' || task.status === 'blocked' ? (
                  <ReassignBox task={task} busy={busy} onReassign={onReassign} />
                ) : null}
              </article>
            );
          })}
        </div>

        {reviewTask ? (
          <AcceptancePanel
            key={reviewTask.id}
            task={reviewTask}
            brief={brief}
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
