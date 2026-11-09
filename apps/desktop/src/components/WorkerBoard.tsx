import type { EmployeeDefinition, Task, Worker } from '@opencoxswain/shared';
import type { WorkerAction } from '../api.js';
import { formatMoney, ROLE_LABELS } from '../ui.js';

const WORKER_LABELS: Record<Worker['status'], string> = {
  starting: '启动中',
  running: '运行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  terminated: '已终止',
};

interface Props {
  workers: Worker[];
  tasks: Task[];
  employees: EmployeeDefinition[];
  busy: boolean;
  onAction: (worker: Worker, action: WorkerAction) => void;
}

export function WorkerBoard({ workers, tasks, employees, busy, onAction }: Props): JSX.Element {
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section className="panel workers">
      <header className="panel-header">
        <h2>员工看板</h2>
        <span className="count">{workers.length}</span>
      </header>
      <div className="panel-body">
        {workers.length === 0 ? (
          <p className="placeholder">员工会在你确认开工后出现，每人一个 worktree。</p>
        ) : null}
        {workers.map((worker) => {
          const task = taskById.get(worker.taskId);
          const taskActive = task !== undefined && !['done', 'cancelled', 'failed'].includes(task.status);
          return (
            <article className="worker-card" data-status={worker.status} key={worker.id}>
              <header>
                <div>
                  <h3>{ROLE_LABELS[worker.role]}</h3>
                  <p className="worker-task">{task?.title ?? worker.taskId}</p>
                </div>
                <span className="worker-status">{WORKER_LABELS[worker.status]}</span>
              </header>
              <dl className="facts">
                <div>
                  <dt>模型</dt>
                  <dd>{worker.model}</dd>
                </div>
                <div>
                  <dt>分支</dt>
                  <dd title={worker.branch}>{worker.branch}</dd>
                </div>
                <div>
                  <dt>花费</dt>
                  <dd>{formatMoney(worker.cost.usd)}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{worker.cost.minutes.toFixed(1)} 分钟</dd>
                </div>
              </dl>
              <p className="worktree" title={worker.worktreePath}>
                {worker.worktreePath}
              </p>
              {task && taskActive ? (
                <div className="row wrap">
                  {task.status === 'running' || task.status === 'queued' ? (
                    <button disabled={busy} onClick={() => onAction(worker, 'pause')}>
                      暂停
                    </button>
                  ) : null}
                  {task.status === 'paused' ? (
                    <button disabled={busy} onClick={() => onAction(worker, 'resume')}>
                      继续
                    </button>
                  ) : null}
                  <button className="danger" disabled={busy} onClick={() => onAction(worker, 'terminate')}>
                    终止
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
        <header className="panel-subheader">
          <h3>已安装员工包</h3>
          <span className="count">{employees.length}</span>
        </header>
        {employees.map((employee) => (
          <article className="worker-card employee-card" key={employee.id}>
            <header>
              <div>
                <h3>
                  {employee.name}
                  <small className="role-tag">{employee.role}</small>
                </h3>
                <p className="worker-task">{employee.description}</p>
              </div>
              <span className="worker-status">
                {employee.readOnly ? '只读' : '可写'}
              </span>
            </header>
            <dl className="facts">
              <div>
                <dt>技能</dt>
                <dd>{employee.skills.join(' / ')}</dd>
              </div>
              <div>
                <dt>工具</dt>
                <dd>{employee.tools.join(' / ')}</dd>
              </div>
              <div>
                <dt>权限</dt>
                <dd>{employee.permissions.join(' / ')}</dd>
              </div>
              <div>
                <dt>默认验收</dt>
                <dd>{employee.acceptanceDefaults.map((item) => item.desc).join('；')}</dd>
              </div>
            </dl>
            <p className="worktree" title={employee.pluginId}>
              插件：{employee.pluginId} v{employee.version}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
