/**
 * 执行者详情（点开跑道后的视图）。
 *
 * 现在只显示真实存在的数据：目标、状态、步数、耗时、结论/卡点、验收结果。
 * **执行轨迹视图待实现**——旧界面有 TraceView，等主流程稳定后再迁移。
 */
import type { ExecutorDto } from '../api.js';
import { laneStatusOf, formatDuration } from './RunnerLane.js';

export interface ExecutorFocusProps {
  readonly executorId: string;
  readonly executors: readonly ExecutorDto[];
  readonly onBack: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  running: '正在执行',
  asking: '等你决定',
  failed: '失败',
  done: '已完成',
  idle: '已取消',
};

export function ExecutorFocus(props: ExecutorFocusProps): JSX.Element {
  const e = props.executors.find((x) => x.id === props.executorId);

  if (!e) {
    return (
      <div className="empty">
        <p className="empty-hint">这个执行者已经不在列表里了。</p>
        <button type="button" className="btn btn--secondary btn--md" onClick={props.onBack}>
          返回对话
        </button>
      </div>
    );
  }

  const status = laneStatusOf(e);
  const elapsed = (e.endedAt ?? Date.now()) - e.createdAt;

  return (
    <div className="transcript">
      <div className="transcript-inner">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={props.onBack}
          style={{ alignSelf: 'flex-start' }}
        >
          ← 返回对话
        </button>

        <div className="msg">
          <span className="msg-who">
            {STATUS_LABEL[status] ?? '执行者'} · {e.label}
          </span>
          <div className="msg-body">
            <p>{e.goal}</p>
            <p
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-sm)',
                color: 'var(--text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {e.metrics?.steps ?? 0} 步 · {formatDuration(elapsed)}
              {e.access === 'readonly' ? ' · 只读' : ''}
            </p>

            {e.blockedReason && (
              <p>
                <span className="chip chip--asking">卡点</span> {e.blockedReason}
              </p>
            )}

            {e.summary && <p>{e.summary}</p>}

            {e.acceptance && (
              <div>
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
                  验收
                </p>
                <ul>
                  {e.acceptance.results.map((r) => (
                    <li key={r.criterion.id}>
                      <span
                        className={
                          r.verdict === 'passed'
                            ? 'chip'
                            : r.verdict === 'failed'
                              ? 'chip chip--failed'
                              : 'chip'
                        }
                      >
                        {r.verdict === 'passed' ? '通过' : r.verdict === 'failed' ? '未通过' : '未验证'}
                      </span>{' '}
                      {r.criterion.desc}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>
              完整执行轨迹待实现。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
