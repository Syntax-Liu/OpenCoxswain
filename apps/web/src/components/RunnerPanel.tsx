/**
 * 跑道面板。
 *
 * 布局顺序按重要性：
 *   1. 待你拍板（置顶，用 --status-asking）
 *   2. 正在跑 / 失败
 *   3. 已完成（收成细线）
 *
 * 面板**不常驻**：没有 Agent 时整个面板不渲染，主区自动变宽。
 * 这是旧界面最大的结构问题（右栏永远占着，大多数时间是空的）。
 */
import { useMemo } from 'react';
import type { ExecutorDto, ReportDto } from '../api.js';
import { DecisionCard } from './DecisionCard.js';
import { RunnerLane, laneStatusOf } from './RunnerLane.js';

export interface RunnerPanelProps {
  readonly executors: readonly ExecutorDto[];
  readonly reports: readonly ReportDto[];
  readonly onOpen: (id: string) => void;
  /** 回答某个待决策：实现方负责转达 **并 ack 报告**。 */
  readonly onAnswer: (report: ReportDto, text: string) => void;
  /** 忽略某条待决策：只 ack，不转达。 */
  readonly onDismiss: (report: ReportDto) => void;
}

/** 需要用户拍板的：有卡点且仍在跑的。 */
export function askingOf(executors: readonly ExecutorDto[]): readonly ExecutorDto[] {
  return executors.filter((e) => laneStatusOf(e) === 'asking');
}

/**
 * 真正的「待你决定」。
 *
 * 重要修正：卡住**不是** `executor.blockedReason`——
 * 实读 orchestrator 后确认，D 跑完就是 done/failed/cancelled，
 * blockedReason 只在 starting 时为 null，永远不会在运行中带原因。
 *
 * 架构里"需要人决定"的表现是 **report.needsUser = true 且未被 ack**。
 * 之前的 asking 判定读错字段，所以决策卡永远不出现。
 */
export function pendingDecisions(
  reports: readonly ReportDto[],
): readonly ReportDto[] {
  return reports.filter((r) => r.needsUser && r.ackedAt === null);
}

/**
 * 活跃的：在跑 + 等着的 + 失败的。
 *
 * **必须包含 asking**。曾经只算 running/failed，
 * 而 asking 又不属于 decisions（那是 report 层），
 * 结果带 blockedReason 的 Agent 三处都不渲染，直接从界面上消失。
 * 一个正在等的 Agent 比一条完成的跑道更需要被看见。
 */
export function activeOf(executors: readonly ExecutorDto[]): readonly ExecutorDto[] {
  return executors.filter((e) => {
    const s = laneStatusOf(e);
    return s === 'running' || s === 'asking' || s === 'failed';
  });
}

/** 已结束的：完成 + 取消。 */
export function finishedOf(executors: readonly ExecutorDto[]): readonly ExecutorDto[] {
  return executors.filter((e) => {
    const s = laneStatusOf(e);
    return s === 'done' || s === 'idle';
  });
}

export function RunnerPanel(props: RunnerPanelProps): JSX.Element {
  const { executors, reports, onOpen, onAnswer, onDismiss } = props;

  const { decisions, active, finished } = useMemo(
    () => ({
      decisions: pendingDecisions(reports),
      active: activeOf(executors),
      finished: finishedOf(executors),
    }),
    [executors, reports],
  );

  // 面板是否该出现：有 Agent，或有待决策
  const liveCount = active.length + decisions.length;

  return (
    <aside className="panel" aria-label="Agent">
      <div className="panel-head">
        <span className="panel-title">Agent</span>
        {liveCount > 0 && <span className="panel-count">{liveCount}</span>}
      </div>

      <div className="panel-body">
        {executors.length === 0 && decisions.length === 0 && (
          <p className="panel-empty">
            还没有 Agent。
            <br />
            在左边对它说一句话，它会派 Agent 去做。
          </p>
        )}

        {decisions.length > 0 && (
          <div className="decisions">
            {decisions.map((r) => (
              <DecisionCard
                key={r.id}
                report={r}
                executorLabel={
                  executors.find((e) => e.id === r.executorId)?.label ?? 'Agent'
                }
                onAnswer={(text) => onAnswer(r, text)}
                onDismiss={() => onDismiss(r)}
                onSeeTrace={() => {
                  if (r.executorId) onOpen(r.executorId);
                }}
              />
            ))}
          </div>
        )}

        <div className="lanes">
          {active.map((e) => (
            <RunnerLane key={e.id} executor={e} onOpen={onOpen} />
          ))}
          {finished.map((e) => (
            <RunnerLane key={e.id} executor={e} onOpen={onOpen} minimized />
          ))}
        </div>
      </div>
    </aside>
  );
}
