/**
 * 方案审阅（主区顶部横条 + 展开详情）。
 *
 * ## 为什么它必须显眼
 *
 * 方案批准是**唯一的人为关卡**。批过一次之后 Assistant 会一路做到完，
 * 中途只报不拦。所以这一刻用户必须看得到、看得懂、能拍板。
 *
 * ## 各状态的表现
 *
 * | 状态 | 横条 | 可做的动作 |
 * | --- | --- | --- |
 * | awaiting-approval | 琥珀边框，最醒目 | 批准 / 驳回 |
 * | approved | 中性，显示进度 | 无（一路跑到底） |
 * | superseded | 琥珀，提示要重批 | 无（等 Assistant 重新出方案） |
 * | blocked | 红，说明卡在哪 | 无（等人处理） |
 * | done | 绿，收成细条 | 无 |
 * | draft | 灰，说明还在起草 | 无 |
 *
 * 小改动（amendments 里 kind=small）只显示一个灰标，**不打断**——
 * 这是用户明确要求的"D7：提示但不中断"。
 */
import { useCallback, useState } from 'react';
import type { PlanDto, PlanStepDto, PlanStepStatus } from '../api.js';

export interface PlanBannerProps {
  readonly plan: PlanDto;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly busy?: boolean;
}

const STEP_ICON: Record<PlanStepStatus, string> = {
  pending: '○',
  running: '◐',
  done: '●',
  failed: '✕',
  blocked: '■',
};

const STEP_LABEL: Record<PlanStepStatus, string> = {
  pending: '待开始',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  blocked: '卡住',
};

export function progressText(plan: PlanDto): string {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return `${done}/${plan.steps.length}`;
}

/** 横条一句话。 */
export function bannerText(plan: PlanDto): string {
  switch (plan.status) {
    case 'awaiting-approval':
      return `方案待批准（${plan.steps.length} 步）`;
    case 'approved':
      return `执行中：${progressText(plan)} 步完成`;
    case 'superseded':
      return '方案有大改动，等重新批准';
    case 'blocked': {
      const stuck = plan.steps.filter((s) => s.status === 'blocked');
      return `卡住了：${stuck.map((s) => s.title).join('、') || '有步骤失败'}`;
    }
    case 'done':
      return `全部完成（${plan.steps.length} 步）`;
    case 'draft':
      return '正在起草方案';
    default:
      return '';
  }
}

/** 横条的状态类名，决定颜色。 */
function bannerClass(plan: PlanDto): string {
  switch (plan.status) {
    case 'awaiting-approval':
      return 'plan-banner asking';
    case 'approved':
      return 'plan-banner running';
    case 'superseded':
      return 'plan-banner asking';
    case 'blocked':
      return 'plan-banner failed';
    case 'done':
      return 'plan-banner done';
    default:
      return 'plan-banner';
  }
}

export function PlanBanner(props: PlanBannerProps): JSX.Element {
  const { plan } = props;
  const [open, setOpen] = useState(plan.status === 'awaiting-approval');

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const canDecide = plan.status === 'awaiting-approval' && !props.busy;
  const smallChanges = plan.amendments.filter((a) => a.kind === 'small');

  return (
    <section className={bannerClass(plan)} aria-label="方案">
      <button
        type="button"
        className="plan-banner-head"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="plan-badge">方案</span>
        <span className="plan-banner-text">{bannerText(plan)}</span>
        {smallChanges.length > 0 && (
          <span
            className="plan-amend-chip"
            title={smallChanges.map((a) => `${a.what}（${a.why}）`).join('\n')}
          >
            {smallChanges.length} 处调整
          </span>
        )}
        <span className="plan-caret">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="plan-body">
          <p className="plan-goal">{plan.goal}</p>

          <ol className="plan-steps">
            {plan.steps.map((s) => (
              <PlanStepRow key={s.id} step={s} />
            ))}
          </ol>

          {plan.amendments.length > 0 && (
            <div className="plan-amendments">
              <span className="plan-amend-title">期间做过的调整</span>
              {plan.amendments.map((a) => (
                <p key={a.id} className={`plan-amend ${a.kind}`}>
                  <span className="chip">{a.kind === 'small' ? '小调整' : '大改动'}</span>
                  {a.what}
                  <span className="plan-amend-why">（{a.why}）</span>
                </p>
              ))}
            </div>
          )}

          {canDecide && (
            <div className="plan-actions">
              <button
                type="button"
                className="btn btn--primary btn--md"
                onClick={props.onApprove}
              >
                批准，开始执行
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--md"
                onClick={props.onReject}
              >
                驳回，让它改
              </button>
            </div>
          )}

          {plan.status === 'awaiting-approval' && (
            <p className="plan-hint">
              批准之后 Assistant 会一路做到完，中途只报不拦；真卡住了才找你。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PlanStepRow(props: { readonly step: PlanStepDto }): JSX.Element {
  const s = props.step;
  return (
    <li className={`plan-step ${s.status}`}>
      <span className="plan-step-icon" aria-hidden>
        {STEP_ICON[s.status]}
      </span>
      <span className="plan-step-id">{s.id}</span>
      <span className="plan-step-title">{s.title}</span>
      <span className="plan-step-status">{STEP_LABEL[s.status]}</span>
      {s.attempts > 0 && (
        <span className="plan-step-attempts" title="已重试次数">
          重试 {s.attempts}
        </span>
      )}
    </li>
  );
}
