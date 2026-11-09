import type { ReactNode } from 'react';
import type { RoleName, TaskStatus } from '@opencoxswain/shared';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '草稿',
  planning: '规划中',
  awaiting_approval: '待审批',
  queued: '排队中',
  running: '执行中',
  awaiting_review: '待验收',
  paused: '已暂停',
  blocked: '已阻塞',
  failed: '失败',
  done: '已完成',
  cancelled: '已取消',
};

export const ROLE_LABELS: Record<RoleName, string> = {
  researcher: '调研员',
  implementer: '实施员',
  verifier: '校验员',
  writer: '文员',
};

export function StatusChip({ status }: { status: TaskStatus }): JSX.Element {
  return (
    <span className="chip" data-status={status}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function Panel(props: {
  title: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      <header className="panel-header">
        <h2>{props.title}</h2>
        {props.actions}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

export function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function formatMinutes(value: number): string {
  return `${value.toFixed(1)} 分钟`;
}

export function MarkdownLite({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n');
  return (
    <div className="markdown">
      {lines.map((line, index) => {
        if (line.startsWith('## ')) return <h3 key={index}>{line.slice(3)}</h3>;
        if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>;
        if (line.startsWith('- ')) {
          return (
            <p className="bullet" key={index}>
              • {line.slice(2)}
            </p>
          );
        }
        if (line.trim() === '') return <div className="markdown-gap" key={index} />;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}
