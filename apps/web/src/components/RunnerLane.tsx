/**
 * 跑道条（签名元素）。
 *
 * 一个 Agent 一条跑道。
 *
 * **不画进度百分比**：后端 `ExecutorDto` 没有这个数据
 * （只有 metrics.steps 和 metrics.durationMs）。编一个假百分比会让人
 * 误判"快好了"，而系统根本不知道还剩多少。
 *
 * 显示的是真实数据：步数、耗时、写域权限、结论摘要。
 */
import type { ExecutorDto } from '../api.js';

export type LaneStatus = 'running' | 'asking' | 'failed' | 'done' | 'idle';

export interface RunnerLaneProps {
  readonly executor: ExecutorDto;
  readonly onOpen: (id: string) => void;
  /** 已完成的收成细线（只显示标题 + 状态点）。 */
  readonly minimized?: boolean;
}

/**
 * 把后端状态映射到视觉状态。
 *
 * `ExecutorStatus` 实际取值：'starting' | 'running' | 'done' | 'failed' | 'cancelled'
 * - starting / running：在跑（有 blockedReason 视为"等你拍板"）
 * - failed：失败
 * - done：完成
 * - cancelled：归入 idle（灰点），它既不是成功也不是失败
 */
export function laneStatusOf(executor: ExecutorDto): LaneStatus {
  if (executor.status === 'running' || executor.status === 'starting') {
    return executor.blockedReason ? 'asking' : 'running';
  }
  if (executor.status === 'failed') return 'failed';
  if (executor.status === 'done') return 'done';
  return 'idle';
}

/** 耗时格式化：不足 1 分钟显示秒，否则显示 分'秒"。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

export function RunnerLane(props: RunnerLaneProps): JSX.Element {
  const { executor: e, onOpen, minimized } = props;
  const status = laneStatusOf(e);

  // 运行中：用已耗时；已结束：用 endedAt - createdAt
  const elapsed =
    e.endedAt !== null ? e.endedAt - e.createdAt : Date.now() - e.createdAt;
  const steps = e.metrics?.steps ?? 0;

  return (
    <button
      type="button"
      className={`lane ${status}${minimized ? ' minimized' : ''}`}
      onClick={() => onOpen(e.id)}
      title={e.goal}
    >
      <span className="lane-top">
        <span className="lane-dot" aria-hidden />
        <span className="lane-title">{e.label}</span>
      </span>

      {!minimized && (
        <>
          <span className="lane-meta">
            {steps > 0 && <span>{steps} 步</span>}
            <span>{formatDuration(elapsed)}</span>
            {e.access === 'readonly' && <span className="lane-scope">只读</span>}
          </span>
          {(e.summary || e.blockedReason) && (
            <span className="lane-summary">{e.blockedReason ?? e.summary}</span>
          )}
        </>
      )}
    </button>
  );
}
