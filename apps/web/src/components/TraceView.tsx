/**
 * 执行轨迹。
 *
 * 显示一条跑道（一个 D）的完整执行过程：用户指令、助手输出、工具调用。
 *
 * 设计：
 * - 工具调用是主角（这是"它到底做了什么"的证据），默认折叠，点开看参数/输出
 * - 时间线用左侧细线串起，不画泳道色块（色块会让长列表变成噪音）
 * - **复用 trace.ts 的解析**：那是旧界面验证过的纯函数，不重写
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExecutorDto, MessageDto } from '../api.js';
import { ApiClient } from '../api.js';
import { buildTrace, describeSpan, type TraceEntry } from './trace.js';
import { formatDuration, laneStatusOf } from './RunnerLane.js';

export interface TraceViewProps {
  readonly executor: ExecutorDto;
  readonly onBack: () => void;
}

const KIND_LABEL: Record<string, string> = {
  user: '指令',
  assistant: '输出',
  tool: '工具',
};

export function TraceView(props: TraceViewProps): JSX.Element {
  const { executor } = props;
  const [messages, setMessages] = useState<readonly MessageDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const api = new ApiClient();
    void api
      .executorMessages(executor.id)
      .then((r) => {
        if (alive) setMessages(r.messages);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [executor.id]);

  const trace = useMemo(() => {
    if (!messages) return null;
    const summary = buildTrace(messages);
    // 去重：派活时同一条指令会被记两次（任务定义 + 会话首条消息）。
    // 相邻且内容相同的"指令"只保留一条，否则轨迹开头会有两条一模一样的长文本。
    const seenInstruction = new Set<string>();
    const entries = summary.entries.filter((e) => {
      if (e.kind !== 'user') return true;
      const key = e.title.trim();
      if (seenInstruction.has(key)) return false;
      seenInstruction.add(key);
      return true;
    });
    return { ...summary, entries, total: entries.length };
  }, [messages]);

  const status = laneStatusOf(executor);
  const elapsed = (executor.endedAt ?? Date.now()) - executor.createdAt;

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

        <header className="trace-head">
          <h2 className="trace-title">{executor.label}</h2>
          <p className="trace-goal">{executor.goal}</p>
          <div className="trace-stats">
            <span className={`chip${status === 'running' ? ' chip--running' : status === 'failed' ? ' chip--failed' : ''}`}>
              {status === 'running' ? '正在执行' : status === 'failed' ? '失败' : status === 'done' ? '已完成' : '已取消'}
            </span>
            {executor.metrics && (
              <>
                <span>{executor.metrics.steps} 步</span>
                <span>{formatDuration(elapsed)}</span>
                {trace && trace.total > 0 && <span>{trace.total} 条记录</span>}
                {trace && trace.spanMs > 0 && <span>跨度 {describeSpan(trace.spanMs)}</span>}
              </>
            )}
          </div>
        </header>

        {executor.blockedReason && (
          <div className="trace-blocked">
            <span className="chip chip--asking">卡点</span>
            <p>{executor.blockedReason}</p>
          </div>
        )}

        {executor.acceptance && executor.acceptance.results.length > 0 && (
          <section className="trace-section">
            <h3 className="trace-section-title">验收</h3>
            <ul className="trace-criteria">
              {executor.acceptance.results.map((r) => (
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
                  </span>
                  <span className="trace-criterion-desc">{r.criterion.desc}</span>
                  {r.note && <span className="trace-criterion-note">{r.note}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="trace-section">
          <h3 className="trace-section-title">执行过程</h3>
          {error && <p className="trace-empty">读取轨迹失败：{error}</p>}
          {!error && messages === null && <p className="trace-empty">正在读取…</p>}
          {!error && trace && trace.entries.length === 0 && (
            <p className="trace-empty">还没有记录。</p>
          )}
          {trace && trace.entries.length > 0 && (
            <ol className="trace-list">
              {trace.entries.map((e) => (
                <TraceRow key={e.id} entry={e} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

function TraceRow(props: { readonly entry: TraceEntry }): JSX.Element {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  const hasDetail = entry.detail.trim().length > 0 && entry.detail !== entry.title;

  return (
    <li className={`trace-row ${entry.kind}`}>
      <span className="trace-dot" aria-hidden />
      <div className="trace-row-main">
        <button
          type="button"
          className="trace-row-head"
          onClick={hasDetail ? toggle : undefined}
          aria-expanded={hasDetail ? open : undefined}
          disabled={!hasDetail}
        >
          <span className="trace-kind">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
          <span className="trace-title-text">{entry.title || entry.label}</span>
          {hasDetail && <span className="trace-caret">{open ? '收起' : '展开'}</span>}
        </button>
        {hasDetail && open && <pre className="trace-detail">{entry.detail}</pre>}
      </div>
    </li>
  );
}
