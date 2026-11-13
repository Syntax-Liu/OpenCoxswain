import { useState } from 'react';

import type { ApprovalDto } from '../api.js';

export interface ApprovalPanelProps {
  readonly approvals: readonly ApprovalDto[];
  /**
   * executorId → Agent 名字。
   *
   * **多个 Agent 会同时请求审批**。不标出是哪个 Agent 的话，
   * 用户看到三条"删除文件"完全分不清谁要删——这正是 Codex 那边
   * 并行会话"被重复审批提示搞到不可用"的根源。
   */
  readonly agentLabels?: ReadonlyMap<string, string>;
  readonly onApprove: (id: string, reason: string) => void;
  readonly onReject: (id: string, reason: string) => void;
}

const CATEGORY_LABEL: Record<string, string> = {
  delete: '删除',
  push: '推送',
  publish: '发布',
  pay: '付款',
  external_send: '对外发送',
};

/**
 * 危险动作审批面板。
 *
 * 这些动作**还没有执行**——批准之前什么都不会发生。
 * 界面必须让这一点无歧义，否则用户会以为"已经做了只是让我确认一下"。
 */
export function ApprovalPanel(props: ApprovalPanelProps): JSX.Element | null {
  const pending = props.approvals.filter((a) => a.status === 'pending');
  if (pending.length === 0) return null;

  return (
    <div className="approval-banner" role="alertdialog" aria-label="待审批的危险动作">
      <div className="approval-head">
        <span className="approval-icon">⚠</span>
        <strong>{pending.length} 个动作等你批准</strong>
        <span className="muted small">未批准前不会执行</span>
      </div>
      <ul className="approval-list">
        {pending.map((item) => (
          <ApprovalItem
            key={item.id}
            approval={item}
            agentLabel={props.agentLabels?.get(item.executorId) ?? null}
            onApprove={(reason) => props.onApprove(item.id, reason)}
            onReject={(reason) => props.onReject(item.id, reason)}
          />
        ))}
      </ul>
    </div>
  );
}

function ApprovalItem({
  approval,
  agentLabel,
  onApprove,
  onReject,
}: {
  approval: ApprovalDto;
  /** 是哪个 Agent 要执行这个动作；查不到时为 null。 */
  agentLabel: string | null;
  onApprove: (reason: string) => void;
  onReject: (reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(false);

  const remaining = Math.max(0, approval.expiresAt - Date.now());
  const minutes = Math.floor(remaining / 60000);

  return (
    <li className="approval-item">
      {/* 先说是谁要干，再说什么事——多个 Agent 同时请求时这是唯一的区分依据 */}
      <div className="approval-who">
        <span className="approval-agent" title={agentLabel ?? '未知 Agent'}>
          {agentLabel ?? '（未知 Agent）'}
        </span>
        <span className="muted small">想执行这个动作</span>
      </div>
      <div className="approval-row">
        <span className={`approval-category ${approval.category}`}>
          {CATEGORY_LABEL[approval.category] ?? approval.category}
        </span>
        <code className="approval-evidence" title={approval.evidence}>
          {approval.evidence}
        </code>
        {minutes > 0 && <span className="muted small">{minutes} 分钟后自动拒绝</span>}
      </div>

      <p className="approval-why">{approval.why}</p>

      <button type="button" className="link" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '收起详情' : '查看完整参数'}
      </button>
      {expanded && (
        <pre className="approval-args">
          {approval.tool} {approval.args}
        </pre>
      )}

      <div className="approval-actions">
        <input
          value={reason}
          placeholder="理由（可选，会告诉Agent）"
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" className="ghost danger" onClick={() => onReject(reason)}>
          拒绝
        </button>
        <button type="button" className="primary" onClick={() => onApprove(reason)}>
          批准执行
        </button>
      </div>
    </li>
  );
}
