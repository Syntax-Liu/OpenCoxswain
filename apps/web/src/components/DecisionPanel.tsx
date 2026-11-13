/**
 * 待决策面板。
 *
 * 半自动自进化要求"人只参与重大决策"。这个面板就是那个介入点——
 * **除了这里和危险动作审批，其它事都不该打扰用户。**
 *
 * 设计取舍：
 * - 放在对话流**上方**固定显示，不随滚动消失
 * - 每条只显示一行摘要，点开看全文
 * - 没有"全部已读"——这些是决策，不是通知
 */
import { useMemo, useState } from 'react';

import type { ReportDto } from '../api.js';
import { decisionPanelTitle, pendingDecisions, summarizeDecision } from './decisions.js';
import { renderMarkdown } from './Markdown.js';

export interface DecisionPanelProps {
  readonly reports: readonly ReportDto[];
  /** 用户点了"我来决定"——把正文带到输入框。 */
  readonly onFocusDecision?: (decisionId: string, body: string) => void;
  /** 标记为已处理（用户决定这事不用回）。 */
  readonly onDismiss?: (reportId: string) => void;
}

export function DecisionPanel(props: DecisionPanelProps): JSX.Element | null {
  const items = useMemo(() => pendingDecisions(props.reports), [props.reports]);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (items.length === 0) return null;

  return (
    <div className="decision-panel" role="region" aria-label="等你决定的事">
      <div className="decision-head">
        <span className="decision-icon" aria-hidden>
          ◆
        </span>
        <strong>{decisionPanelTitle(items.length)}</strong>
        <span className="muted small">这些是方向性的选择，不是普通汇报</span>
      </div>

      <ul className="decision-list">
        {items.map((item) => (
          <li key={item.id} className="decision-item">
            <button
              type="button"
              className="decision-summary"
              aria-expanded={expanded === item.id}
              onClick={() => setExpanded((v) => (v === item.id ? null : item.id))}
            >
              {summarizeDecision(item.body)}
            </button>

            {expanded === item.id && (
              <div className="decision-body md-body">{renderMarkdown(item.body)}</div>
            )}

            <div className="decision-actions">
              {props.onFocusDecision && (
                <button
                  type="button"
                  className="link"
                  onClick={() => props.onFocusDecision!(item.id, item.body)}
                >
                  我来回答
                </button>
              )}
              {props.onDismiss && (
                <button
                  type="button"
                  className="link muted"
                  title="不用回答，只是标记它已看过"
                  onClick={() => props.onDismiss!(item.id)}
                >
                  不需要决定
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
