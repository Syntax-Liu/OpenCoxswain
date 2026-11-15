/**
 * 审批面板（危险动作确认）。
 *
 * 这是**安全入口**，不是体验优化：没有它，危险动作的确认环节在界面上是缺失的。
 *
 * 设计原则：
 * 1. **先说清楚要做什么、为什么**——`evidence` / `why` / `tool` + `args` 三样都给人看；
 * 2. 拒绝**必须带理由**（后端也这么要求），所以理由输入框在拒绝时才出现；
 * 3. 待审批置顶、显示剩余时间（`expiresAt`，超时自动拒绝）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApprovalDto } from '../api.js';

export interface ApprovalPanelProps {
  readonly approvals: readonly ApprovalDto[];
  readonly onApprove: (id: string, reason?: string) => void;
  readonly onReject: (id: string, reason: string) => void;
}

/** 剩余时间文案。 */
export function describeRemaining(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return '已过期';
  const min = Math.floor(ms / 60000);
  if (min >= 60) return `剩 ${Math.floor(min / 60)} 小时`;
  if (min >= 1) return `剩 ${min} 分钟`;
  return `剩 ${Math.ceil(ms / 1000)} 秒`;
}

const CATEGORY_LABEL: Record<string, string> = {
  delete: '删除',
  push: '推送',
  publish: '发布',
  pay: '付款',
  external_send: '外发',
};

export function ApprovalPanel(props: ApprovalPanelProps): JSX.Element | null {
  const pending = useMemo(
    () => props.approvals.filter((a) => a.status === 'pending'),
    [props.approvals],
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pending.length]);

  if (pending.length === 0) return null;

  return (
    <section className="approvals" aria-label="待审批的危险动作">
      {pending.map((a) => (
        <ApprovalItem
          key={a.id}
          approval={a}
          now={now}
          onApprove={props.onApprove}
          onReject={props.onReject}
        />
      ))}
    </section>
  );
}

function ApprovalItem(props: {
  readonly approval: ApprovalDto;
  readonly now: number;
  readonly onApprove: (id: string, reason?: string) => void;
  readonly onReject: (id: string, reason: string) => void;
}): JSX.Element {
  const { approval: a, now } = props;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [showArgs, setShowArgs] = useState(false);

  const submitReject = useCallback(() => {
    const v = reason.trim();
    if (!v) return;
    props.onReject(a.id, v);
    setRejecting(false);
    setReason('');
  }, [a.id, reason, props]);

  return (
    <div className="approval">
      <div className="approval-head">
        <span className="chip chip--asking">{CATEGORY_LABEL[a.category] ?? a.category}</span>
        <span className="approval-tool">{a.tool}</span>
        <span className="approval-time">{describeRemaining(a.expiresAt, now)}</span>
      </div>

      {a.why && <p className="approval-why">{a.why}</p>}
      {a.evidence && <p className="approval-evidence">{a.evidence}</p>}

      {a.args && (
        <div className="approval-args">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setShowArgs((v) => !v)}
            aria-expanded={showArgs}
          >
            {showArgs ? '收起参数' : '看参数'}
          </button>
          {showArgs && <pre className="approval-args-body">{a.args}</pre>}
        </div>
      )}

      {!rejecting ? (
        <div className="approval-actions">
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => props.onApprove(a.id)}
          >
            允许这一次
          </button>
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={() => setRejecting(true)}
          >
            拒绝
          </button>
        </div>
      ) : (
        <div className="approval-reject">
          <textarea
            className="decision-input"
            rows={2}
            value={reason}
            placeholder="说明拒绝理由（必填）"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitReject();
              }
            }}
          />
          <div className="approval-actions">
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={submitReject}
              disabled={reason.trim().length === 0}
            >
              确认拒绝
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                setRejecting(false);
                setReason('');
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
