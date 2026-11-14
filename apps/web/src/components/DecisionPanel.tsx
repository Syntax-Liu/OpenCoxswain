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
import {
  DECISION_VISIBLE_LIMIT,
  decisionPanelTitle,
  hiddenDecisionCount,
  pendingDecisions,
  summarizeDecision,
  visibleDecisions,
} from './decisions.js';
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
  /** 是否展开全部待决策（默认只显示前几条，不让面板压垮主区域）。 */
  const [showAll, setShowAll] = useState(false);

  const shown = useMemo(() => visibleDecisions(items, showAll), [items, showAll]);
  const hidden = hiddenDecisionCount(items, showAll);

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
        {shown.map((item) => (
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

            {/* **操作按钮悬停才出现**。
                之前每条都常驻显示，4 条就是 8 个操作项，
                面板里一半的像素被"我来回答 / 不需要决定"占掉。

                悬停显示 + 键盘 focus 也显示（`focus-within`），
                不影响可访问性。 */}
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
                  title="标记为已看过，之后不再出现在这个面板里"
                  onClick={() => props.onDismiss!(item.id)}
                >
                  标记已看过
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {hidden > 0 && (
        <button type="button" className="link decision-more" onClick={() => setShowAll(true)}>
          还有 {hidden} 件（展开）
        </button>
      )}
      {showAll && items.length > DECISION_VISIBLE_LIMIT && (
        <button type="button" className="link muted decision-more" onClick={() => setShowAll(false)}>
          收起
        </button>
      )}
    </div>
  );
}
