/**
 * 跑道面板。
 *
 * 布局顺序按重要性：
 *   1. 待你拍板（置顶，用 --status-asking）
 *   2. 正在跑 / 失败
 *   3. 已完成（收成细线）
 *
 * 面板**不常驻**：没有执行者时整个面板不渲染，主区自动变宽。
 * 这是旧界面最大的结构问题（右栏永远占着，大多数时间是空的）。
 */
import { useMemo } from 'react';
import type { ExecutorDto } from '../api.js';
import { RunnerLane, laneStatusOf } from './RunnerLane.js';

export interface RunnerPanelProps {
  readonly executors: readonly ExecutorDto[];
  readonly onOpen: (id: string) => void;
  readonly onDecide: (executorId: string) => void;
}

/** 需要用户拍板的：有卡点且仍在跑的。 */
export function askingOf(executors: readonly ExecutorDto[]): readonly ExecutorDto[] {
  return executors.filter((e) => laneStatusOf(e) === 'asking');
}

/** 活跃的：在跑 + 失败（失败要留在视野里）。 */
export function activeOf(executors: readonly ExecutorDto[]): readonly ExecutorDto[] {
  return executors.filter((e) => {
    const s = laneStatusOf(e);
    return s === 'running' || s === 'failed';
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
  const { executors, onOpen, onDecide } = props;

  const { asking, active, finished } = useMemo(
    () => ({
      asking: askingOf(executors),
      active: activeOf(executors),
      finished: finishedOf(executors),
    }),
    [executors],
  );

  const liveCount = asking.length + active.length;

  return (
    <aside className="panel" aria-label="执行者">
      <div className="panel-head">
        <span className="panel-title">执行者</span>
        {liveCount > 0 && <span className="panel-count">{liveCount}</span>}
      </div>

      <div className="panel-body">
        {executors.length === 0 && (
          <p className="panel-empty">
            还没有执行者。
            <br />
            在左边对它说一句话，它会派 Agent 去做。
          </p>
        )}

        {asking.length > 0 && (
          <div className="decisions">
            {asking.map((e) => (
              <div className="decision" key={e.id}>
                <span className="decision-from">{e.label}</span>
                <p className="decision-q">{e.blockedReason ?? '需要你决定'}</p>
                <div className="decision-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => onDecide(e.id)}
                  >
                    查看并处理
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onOpen(e.id)}
                  >
                    看执行过程
                  </button>
                </div>
              </div>
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
