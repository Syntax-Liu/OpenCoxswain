import type { Approval, Task } from '@opencoxswain/shared';
import { ROLE_LABELS } from '../ui.js';

interface Props {
  root: Task | null;
  children: Task[];
  approvals: Approval[];
  busy: boolean;
  onRootAction: (action: 'approve' | 'reject') => void;
  onTaskAction: (taskId: string, action: 'retry' | 'cancel') => void;
  onApproval: (approvalId: string, status: 'approved' | 'rejected') => void;
}

function approvalSummary(approval: Approval): string {
  const payload = approval.payload as { tool?: string; category?: string } | null;
  if (payload?.tool) return `${payload.category ?? approval.type}：${payload.tool}`;
  return approval.type;
}

/** 待决策收件箱：只列需要人处理的事，不重复展示执行过程。 */
export function Inbox({
  root,
  children,
  approvals,
  busy,
  onRootAction,
  onTaskAction,
  onApproval,
}: Props): JSX.Element | null {
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const stuck = children.filter(
    (task) => task.status === 'blocked' || task.status === 'failed',
  );
  const planWaiting = root?.status === 'awaiting_approval';
  const reviewWaiting = root?.status === 'awaiting_review';
  const total = pending.length + stuck.length + (planWaiting ? 1 : 0) + (reviewWaiting ? 1 : 0);
  if (total === 0) return null;

  return (
    <section className="panel inbox">
      <header className="panel-header">
        <h2>待决策</h2>
        <span className="count">{total}</span>
      </header>
      {planWaiting && root ? (
        <div className="inbox-item">
          <div>
            <strong>任务单待确认</strong>
            <p>{root.title}</p>
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => onRootAction('approve')}>
              确认开工
            </button>
            <button disabled={busy} onClick={() => onRootAction('reject')}>
              退回
            </button>
          </div>
        </div>
      ) : null}
      {reviewWaiting ? (
        <div className="inbox-item">
          <div>
            <strong>验收待处理</strong>
            <p>在任务树底部逐条给出结论与理由。</p>
          </div>
        </div>
      ) : null}
      {pending.map((approval) => (
        <div className="inbox-item" key={approval.id}>
          <div>
            <strong>危险动作待审批</strong>
            <p>{approvalSummary(approval)}</p>
          </div>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => onApproval(approval.id, 'approved')}
            >
              批准
            </button>
            <button disabled={busy} onClick={() => onApproval(approval.id, 'rejected')}>
              拒绝
            </button>
          </div>
        </div>
      ))}
      {stuck.map((task) => (
        <div className="inbox-item" key={task.id}>
          <div>
            <strong>
              {task.status === 'blocked' ? '任务阻塞' : '任务失败'} ·{' '}
              {task.contract.assignee ? ROLE_LABELS[task.contract.assignee.role] : '未指派'}
            </strong>
            <p>{task.title}</p>
          </div>
          <div className="row">
            <button disabled={busy} onClick={() => onTaskAction(task.id, 'retry')}>
              重试
            </button>
            <button disabled={busy} onClick={() => onTaskAction(task.id, 'cancel')}>
              取消
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
