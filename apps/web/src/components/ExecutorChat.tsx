import { useEffect, useRef, useState } from 'react';

import type { ExecutorDto, MessageDto, SideEffectDto } from '../api.js';
import { EXECUTOR_STATUS_LABEL } from '../state.js';
import { cacheHitRate, formatDuration, formatPercent, formatRate, formatTokens, summarize } from '../metrics.js';
import { renderMarkdown } from './Markdown.js';
import { clearDraft, draftKey as draftKeyFor, loadDraft, saveDraft } from '../drafts.js';

export interface ExecutorChatProps {
  readonly executor: ExecutorDto;
  readonly messages: readonly MessageDto[];
  readonly effects: readonly SideEffectDto[];
  /** 撤销一次文件写入。 */
  readonly onUndo?: (effectId: string) => void;
  readonly loading: boolean;
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
  readonly onBack: () => void;
}

/**
 * 一个 Agent（Agent） 的对话视图。
 *
 * 结构对齐主流 Agent 软件：这里就是"打开原会话"。
 * - 首条是它的任务目标；
 * - 中间是每一步工具调用与结果的轨迹；
 * - 末尾是它的结论；
 * - 用户可以在下面继续追问（**带原上下文**续跑）。
 */
export function ExecutorChat(props: ExecutorChatProps): JSX.Element {
  // 草稿：每个 Agent 一份，切走再回来内容还在
  const draftKey = draftKeyFor({ kind: 'executor', executorId: props.executor.id });
  const [draft, setDraft] = useState(() => loadDraft(draftKey));

  const updateDraft = (text: string): void => {
    setDraft(text);
    saveDraft(draftKey, text);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = props.executor.status === 'running' || props.executor.status === 'starting';

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length, busy]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    props.onSend(text);
    setDraft('');
    clearDraft(draftKey);
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <button type="button" className="ghost back-btn" onClick={props.onBack}>
          ← 返回
        </button>
        <div className="header-main">
          <h2>{props.executor.label}</h2>
          <p className="muted small">
            {props.executor.access === 'readonly' ? '只读Agent' : 'Agent'} ·{' '}
            {EXECUTOR_STATUS_LABEL[props.executor.status]}
          </p>
        </div>
        {busy && (
          <button type="button" className="ghost" onClick={props.onCancel}>
            取消
          </button>
        )}
      </header>

      <div className="messages" ref={scrollRef}>
        <section className="goal-card">
          <p className="muted small">任务目标</p>
          <div className="md-body">{renderMarkdown(props.executor.goal)}</div>
          {props.executor.blockedReason && (
            <div className="blocked md-body">{renderMarkdown(props.executor.blockedReason)}</div>
          )}
          <AcceptanceBlock executor={props.executor} />
          <EffectsBlock effects={props.effects} onUndo={props.onUndo} />
        </section>

        {props.loading && <p className="muted small">正在读取执行记录…</p>}

        {props.messages.map((message) => (
          <TranscriptItem key={message.id} message={message} />
        ))}

        {busy && (
          <div className="message assistant">
            <span className="msg-role">Agent</span>
            <div className="bubble">
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        {/* **和主对话用同一套结构**。
            之前这里直接是 `.composer > textarea`，少了 `.composer-box` 这一层，
            所以 Agent 页的输入框是一条裸线，而主对话是有边框圆角的盒子。
            两个页面的对话框看起来是两种东西。 */}
        <div className="composer-box">
          <textarea
            value={draft}
            placeholder={busy ? 'Agent还在跑，等它结束再追问…' : '继续追问这个 Agent（它会带着原有上下文继续）'}
            disabled={busy}
            onChange={(e) => updateDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
          />
          <div className="composer-bar">
            <div className="composer-left">
              <MetricsLine executor={props.executor} />
            </div>
            <button type="button" className="primary small" onClick={submit} disabled={busy || !draft.trim()}>
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 副作用清单："它到底改了什么"。
 *
 * 只列**有副作用**的动作（读写文件、执行命令、对外发送），
 * 读文件之类的纯查询不进台账——否则清单会被噪音淹没。
 */
function EffectsBlock({
  effects,
  onUndo,
}: {
  effects: readonly SideEffectDto[];
  onUndo?: (effectId: string) => void;
}): JSX.Element | null {
  if (effects.length === 0) return null;

  const label: Record<SideEffectDto['kind'], string> = {
    'fs.write': '写文件',
    'fs.delete': '删文件',
    'proc.exec': '执行命令',
    'net.send': '对外发送',
  };

  const stateLabel: Record<SideEffectDto['state'], string> = {
    pending: '进行中',
    succeeded: '已执行',
    failed: '失败',
    rejected: '被拒绝（未执行）',
    undone: '已撤销',
  };

  /**
   * 能不能撤销。
   *
   * **只有文件写入可以**——跑过的命令撤不了、发出去的请求收不回。
   * 这里和运行时侧的 `isUndoable` 保持一致，不给出会失败的按钮。
   */
  const canUndo = (e: SideEffectDto): boolean =>
    e.kind === 'fs.write' && e.reversible && e.state === 'succeeded';

  return (
    <div className="effects">
      <p className="muted small">改动了什么（{effects.length} 项）</p>
      <ul className="effects-list">
        {effects.map((e) => (
          <li key={e.id} className={e.state}>
            <span className="eff-kind">{label[e.kind]}</span>
            <code className="eff-target" title={e.target}>
              {e.target}
            </code>
            <span className="eff-state">
              {stateLabel[e.state]}
              {!e.reversible && <span className="eff-irrev">不可撤销</span>}
              {/* 可撤销的给一个按钮——之前只标了"不可撤销"，
                  能撤的反而没有任何入口 */}
              {canUndo(e) && onUndo && (
                <button
                  type="button"
                  className="link eff-undo"
                  title="把这个文件恢复到这次改动之前"
                  onClick={() => onUndo(e.id)}
                >
                  撤销
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 验收结果。
 *
 * 显示"系统自己验了什么、结果如何"。
 * 没声明标准时明确写"未声明"，**不能显示成通过**。
 */
function AcceptanceBlock({ executor }: { executor: ExecutorDto }): JSX.Element | null {
  const a = executor.acceptance;
  if (!a) return null;

  const label =
    a.verdict === 'passed' ? '系统复核通过' : a.verdict === 'failed' ? '系统复核未通过' : '待人工确认';

  return (
    <div className={`acceptance ${a.verdict}`}>
      <div className="acceptance-head">
        <span className="acceptance-verdict">{label}</span>
        {a.verdict === 'failed' && <span className="muted small">失败不可人工覆盖</span>}
      </div>
      <ul className="acceptance-list">
        {a.results.map((r) => (
          <li key={r.criterion.id} className={r.verdict}>
            <span className="acc-icon">
              {r.verdict === 'passed' ? '✓' : r.verdict === 'failed' ? '✗' : '?'}
            </span>
            <span className="acc-desc">{r.criterion.desc}</span>
            <span className="acc-note">{r.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 运行指标行。
 *
 * 仿 DeepSeek Harness 的底部状态条：轮次、步数、吞吐、总量、缓存、上下文。
 * **不做计费**——不同模型单价不同且随时调整，估出来的金额只会误导人。
 */
export function MetricsLine({ executor }: { executor: ExecutorDto }): JSX.Element | null {
  const m = executor.metrics;
  if (!m || (m.turns === 0 && m.tokensIn === 0)) return null;

  const hit = cacheHitRate(m);
  const items: string[] = [];
  if (m.turns > 0) items.push(`${m.turns} 轮`);
  if (m.steps > 0) items.push(`${m.steps} 步`);
  if (m.tokensOut > 0 && m.durationMs > 0) items.push(formatRate(m.tokensOut, m.durationMs));
  items.push(`${formatTokens(m.tokensIn + m.tokensOut)} tok`);
  if (m.durationMs > 0) items.push(formatDuration(m.durationMs));
  if (hit !== null) items.push(`缓存 ${formatPercent(hit)}`);
  if (m.contextTokens !== null) items.push(`上下文 ${formatTokens(m.contextTokens)}`);

  return (
    <span className="metrics-line" title="运行指标（不估算金额：单价随模型变动，请以服务商后台为准）">
      {items.join(' · ')}
    </span>
  );
}

/**
 * 一条轨迹记录。
 *
 * 工具调用与工具结果是**执行过程**，用紧凑样式显示，不要和对话抢视觉。
 */
function TranscriptItem({ message }: { message: MessageDto }): JSX.Element | null {
  // 首条目标已经在顶部目标卡片里显示过，跳过。
  if (message.source === 'assistant' && message.role === 'user') return null;

  if (message.source === 'tool') {
    return (
      <div className="tool-row">
        <span className="tool-badge">调用</span>
        <code>{message.content}</code>
      </div>
    );
  }

  if (message.source === 'tool-result') {
    const failed = message.content.startsWith('（失败）');
    return (
      <div className={`tool-row result${failed ? ' failed' : ''}`}>
        <span className="tool-badge">结果</span>
        <span className="tool-output">{message.content.replace(/^（失败）/, '')}</span>
      </div>
    );
  }

  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="bubble">{renderMarkdown(message.content)}</div>
      </div>
    );
  }

  return (
    <div className="message assistant">
      <span className="msg-role">Agent</span>
      <div className="bubble">{renderMarkdown(message.content)}</div>
    </div>
  );
}
