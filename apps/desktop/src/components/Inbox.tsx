import type { Approval, ReviewLatency, Task } from '@opencoxswain/shared';
import { ROLE_LABELS } from '../ui.js';

interface Props {
  root: Task | null;
  tasks: Task[];
  approvals: Approval[];
  latency: ReviewLatency;
  busy: boolean;
  onRootAction: (action: 'approve' | 'reject') => void;
  onTaskAction: (taskId: string, action: 'retry' | 'cancel') => void;
  onApproval: (approvalId: string, status: 'approved' | 'rejected') => void;
  onReview: (taskId: string) => void;
}

function approvalSummary(approval: Approval): string {
  const payload = approval.payload as { tool?: string; category?: string } | null;
  if (payload?.tool) return `${payload.category ?? approval.type}：${payload.tool}`;
  return approval.type;
}

function waitText(task: Task): string {
  const since = task.finishedAt ?? task.updatedAt;
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60000));
  if (minutes < 1) return '刚刚完成';
  if (minutes < 60) return `已等待 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `已等待 ${hours} 小时 ${minutes % 60} 分`;
}

function lagText(value: number | null): string {
  if (value === null) return '—';
  const minutes = Math.round(value / 60000);
  if (minutes < 1) return '<1 分';
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 需要人处理的事项总数；侧边栏与页面标题共用。 */
export function pendingDecisionCount(
  root: Task | null,
  tasks: Task[],
  approvals: Approval[],
): number {
  const pending = approvals.filter((approval) => approval.status === 'pending').length;
  const stuck = tasks.filter(
    (task) =>
      task.parentId !== null && (task.status === 'blocked' || task.status === 'failed'),
  ).length;
  const reviews = tasks.filter((task) => task.status === 'awaiting_review').length;
  return pending + stuck + reviews + (root?.status === 'awaiting_approval' ? 1 : 0);
}

/** 待决策收件箱：只列需要人处理的事，不重复展示执行过程。 */
export function Inbox({
  root,
  tasks,
  approvals,
  latency,
  busy,
  onRootAction,
  onTaskAction,
  onApproval,
  onReview,
}: Props): JSX.Element {
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const children = tasks.filter((task) => task.parentId !== null);
  const stuck = children.filter(
    (task) => task.status === 'blocked' || task.status === 'failed',
  );
  const reviews = tasks.filter((task) => task.status === 'awaiting_review');
  const planWaiting = root?.status === 'awaiting_approval';
  const total = pendingDecisionCount(root, tasks, approvals);
  if (total === 0) {
    return (
      <section className="panel inbox">
        <p className="page-empty">没有待处理的事，总管和员工都在按计划推进。</p>
      </section>
    );
  }

  const doneChildren = children.filter((task) => task.status === 'done').length;

  return (
    <section className="panel inbox">
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
      {reviews.map((task) => {
        const isRoot = task.parentId === null;
        const pendingChildren = children.filter((child) => child.status !== 'done').length;
        return (
          <div className="inbox-item" key={task.id}>
            <div>
              <strong>
                {isRoot ? '汇总待收口' : '子任务待验收'}
                <span className="muted role-inline">
                  {task.contract.assignee ? ROLE_LABELS[task.contract.assignee.role] : '总管'}
                </span>
              </strong>
              <p>
                {isRoot && pendingChildren > 0
                  ? `汇总中 ${doneChildren}/${children.length}：还有 ${pendingChildren} 个子任务未验收`
                  : task.title}
              </p>
              <small className="muted">{waitText(task)}</small>
            </div>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => onReview(task.id)}>
                去验收
              </button>
            </div>
          </div>
        );
      })}
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
              {task.status === 'blocked' ? '任务阻塞' : '任务失败'}
              <span className="muted role-inline">
                {task.contract.assignee ? ROLE_LABELS[task.contract.assignee.role] : '未指派'}
              </span>
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
      {latency.samples > 0 || latency.waiting > 0 ? (
        <footer className="inbox-latency hint">
          反馈延迟 p50 {lagText(latency.viewLagP50)}，p95 {lagText(latency.viewLagP95)}
          （样本 {latency.samples}，待处理 {latency.waiting}）
        </footer>
      ) : null}
    </section>
  );
}
