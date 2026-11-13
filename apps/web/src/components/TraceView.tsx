import { useMemo, useState } from 'react';

import type { MessageDto } from '../api.js';
import { TRACE_FILTERS, countByFilter, filterTrace, type TraceFilter } from './traceFilter.js';
import { buildTrace, describeSpan, timelineSegments } from './trace.js';

/**
 * 轨迹页（照 DeepSeek Harness）。
 *
 * ```
 * ⏱ 时长 4 分 12 秒   轮次 52   调用 2531      [搜索]
 * ┤▏▎▍▌▋█▉▊▍▎▏▎▍▌▋█▉▊▍▎▏▎▍▌▋█▉▊▍▎▏▎▍▌▋█▉▊▍▎▏│  ← 时间轴
 * ● 工具  command: pnpm test           ← 每行：圆点 + 标签 + 摘要
 * ● 助手  测试通过，接下来…
 * ● 你    安装包打不开
 * ```
 *
 * 和对话页的分工：
 * - 对话页只显示人说的 + Assistant 最终回复
 * - 轨迹页显示**全部中间过程**，包括被隐藏的内部通知
 */

export interface TraceViewProps {
  readonly messages: readonly MessageDto[];
}

export function TraceView(props: TraceViewProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 筛子：全部 / 只看失败 / 只看写操作。 */
  const [filter, setFilter] = useState<TraceFilter>('all');

  const trace = useMemo(() => buildTrace(props.messages), [props.messages]);
  const counts = useMemo(() => countByFilter(trace.entries), [trace.entries]);

  const filtered = useMemo(
    () => filterTrace(trace.entries, filter, query),
    [trace.entries, filter, query],
  );

  const segments = timelineSegments(trace);

  if (trace.total === 0) {
    return (
      <div className="trace-empty">
        <p className="muted">还没有轨迹。派一个任务之后，这里会显示每一次工具调用和回复。</p>
      </div>
    );
  }

  return (
    <div className="trace-view">
      {/* 顶部统计 */}
      <div className="trace-stats">
        <span className="trace-stat">
          <span className="trace-stat-key">时长</span>
          <span className="trace-stat-value">{describeSpan(trace.spanMs)}</span>
        </span>
        <span className="trace-stat">
          <span className="trace-stat-key">轮次</span>
          <span className="trace-stat-value">{trace.counts.user + trace.counts.assistant}</span>
        </span>
        <span className="trace-stat">
          <span className="trace-stat-key">工具调用</span>
          <span className="trace-stat-value">{trace.counts.tool}</span>
        </span>
        <input
          className="trace-search"
          value={query}
          placeholder="搜索轨迹"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索轨迹"
        />
      </div>

      {/* 筛子：几十上百条记录里，先缩小范围再找 */}
      <div className="trace-filters" role="group" aria-label="筛选轨迹">
        {TRACE_FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`trace-filter-btn${filter === option.id ? ' active' : ''}`}
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
            <span className="trace-filter-count">{counts[option.id]}</span>
          </button>
        ))}
      </div>

      {/* 时间轴：每段一次调用，按类型着色 */}
      <div className="trace-timeline" role="img" aria-label="调用时间轴">
        {segments.map((kind, index) => (
          <span key={index} className={`trace-seg ${kind}`} title={kind} />
        ))}
      </div>

      {/* 明细列表 */}
      <ul className="trace-list">
        {filtered.map((entry) => (
          <li key={entry.id} className={`trace-row ${entry.kind}`}>
            <span className="trace-dot" aria-hidden />
            <span className="trace-label">{entry.label}</span>
            <button
              type="button"
              className="trace-title"
              onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
              title={expanded === entry.id ? '收起' : '展开完整内容'}
            >
              {entry.title}
            </button>
            <span className="trace-time">{formatTime(entry.at)}</span>
            {expanded === entry.id && <pre className="trace-detail">{entry.detail}</pre>}
          </li>
        ))}
      </ul>

      {filtered.length === 0 && <p className="muted small trace-no-match">没有匹配的记录。</p>}
    </div>
  );
}

function formatTime(at: number): string {
  const date = new Date(at);
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
