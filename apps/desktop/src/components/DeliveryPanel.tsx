import { useState } from 'react';
import type { DeliveryMergeResult, DeliveryPlan } from '@opencoxswain/shared';
import { DecisionBriefView } from './DecisionBriefView.js';
import { DiffReviewView } from './DiffReviewView.js';

interface Props {
  plan: DeliveryPlan | null;
  result: DeliveryMergeResult | null;
  merging: boolean;
  onMerge: (planHash: string) => void;
}

/**
 * 交付说明 + 一键合并。
 * 说明复用决策说明四段；合并必须二次确认，且只对低风险交付开放。
 */
export function DeliveryPanel({ plan, result, merging, onMerge }: Props): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  if (!plan && !result) return null;

  if (result) {
    return (
      <section className="delivery-panel">
        <header className="panel-subheader">
          <h3>交付</h3>
          <span className="role-tag">已合并</span>
        </header>
        <p>
          已合入 {result.baseBranch}，当前提交 {result.head.slice(0, 8)}。
        </p>
        <p className="hint">分支：{result.branches.join('、') || '无'}</p>
      </section>
    );
  }

  const value = plan!;
  return (
    <section className="delivery-panel">
      <header className="panel-subheader">
        <h3>交付说明</h3>
        <span className={value.risk === 'low' ? 'role-tag' : 'role-tag danger-text'}>
          {value.risk === 'low' ? '低风险' : '高风险'}
        </span>
      </header>
      <article className="decision-brief">
        <DecisionBriefView brief={value.brief} />
        <details className="diff-review-fold" open>
          <summary>逐文件改动（对应「改了什么」）</summary>
          <DiffReviewView taskId={value.taskId} />
        </details>
      </article>
      <dl className="delivery-meta">
        <div>
          <dt>目标分支</dt>
          <dd>{value.baseBranch}</dd>
        </div>
        <div>
          <dt>待合并分支</dt>
          <dd>{value.branches.join('、') || '无'}</dd>
        </div>
        <div>
          <dt>改动规模</dt>
          <dd>
            {value.changedFiles.length} 个文件，+{value.additions} / -{value.deletions}
          </dd>
        </div>
        <div>
          <dt>失败回退</dt>
          <dd>
            <code>{value.rollback}</code>
          </dd>
        </div>
      </dl>
      {value.riskReasons.length > 0 ? (
        <p className="hint">风险判定：{value.riskReasons.join('；')}</p>
      ) : null}
      {value.blockedReasons.length > 0 ? (
        <ul className="hint">
          {value.blockedReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {value.mergeable ? (
        confirming ? (
          <div className="merge-confirm">
            <p>
              将把 {value.branches.length} 个分支合入 <strong>{value.baseBranch}</strong>。
              合并失败会自动回滚到 {value.rollback.replace('git reset --hard ', '')}。
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={merging}
                onClick={() => {
                  setConfirming(false);
                  onMerge(value.planHash);
                }}
              >
                确认合并
              </button>
              <button disabled={merging} onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <button className="primary" disabled={merging} onClick={() => setConfirming(true)}>
            一键合并（需确认）
          </button>
        )
      ) : (
        <p className="hint">当前交付不提供一键合并；请按上面的分支手动处理。</p>
      )}
    </section>
  );
}
