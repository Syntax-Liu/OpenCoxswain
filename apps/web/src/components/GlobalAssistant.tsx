import { useState } from 'react';

import type { ApiClient, ProjectDto } from '../api.js';
import { IconSidebar, IconSupervisor } from './icons.js';

export interface GlobalAssistantProps {
  /** 右侧边栏是否展开（和主对话保持一致）。 */
  readonly railOpen?: boolean;
  /** 切换右侧边栏。 */
  readonly onToggleRail?: () => void;
  readonly api: ApiClient;
  readonly projects: readonly ProjectDto[];
  readonly onOpenAssistant: (projectId: string) => void;
}

interface RouteResult {
  readonly decision: 'unique' | 'ambiguous' | 'none';
  readonly candidates: Array<{ projectId: string; name: string; score: number; reasons: string[] }>;
  readonly hint: string;
}

/**
 * Supervisor：只在多项目迷路时用。
 *
 * Supervisor 的职责严格收窄为**指路 + 转交原话**：
 * - 给出依据（为什么是这个项目）；
 * - 依据不足或等分时反问，不硬猜；
 * - 转交的是用户原话，绝不改写，也绝不代 C 汇报。
 */
export function GlobalAssistant(props: GlobalAssistantProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RouteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (): Promise<void> => {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setHandoffNote(null);
    try {
      setResult(await props.api.route(text));
    } catch (e) {
      setError(e instanceof Error ? e.message : '路由失败');
    } finally {
      setBusy(false);
    }
  };

  const handoff = async (projectId: string, projectName: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await props.api.handoff(projectId, query.trim());
      setHandoffNote(`已把原话转交给「${projectName}」的Assistant。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '转交失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conversation">
      <header className="conversation-header">
        <div className="header-main">
          <h2>Supervisor</h2>
          <p className="muted small">只在多个项目之间迷路时用。我负责指路，不替Assistant干活。</p>
        </div>
        {/* 侧边栏开关：和主对话一样常驻在标题行最右边 */}
        {props.onToggleRail && (
          <div className="header-side">
            <button
              type="button"
              className={`rail-toggle${props.railOpen ? ' active' : ''}`}
              onClick={props.onToggleRail}
              title={props.railOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-pressed={props.railOpen}
            >
              <IconSidebar size={16} />
            </button>
          </div>
        )}
      </header>

      <div className="messages">
        {/* **和主对话的空状态统一**：之前这里是一块 hint-card，
            在别的页面（主对话）已经是居中的欢迎页，两处不一致。 */}
        <div className="welcome">
          <div className="welcome-brand">
            <IconSupervisor size={36} className="is-triangle" />
            <h1>Supervisor</h1>
          </div>
          <p className="welcome-sub">
            说一句想推进的事，我告诉你该找哪个项目。
            我只指路，不替 Assistant 干活。
          </p>
          <div className="welcome-examples">
            <span>当前项目：</span>
            {props.projects.length === 0 ? (
              <span>还没有项目</span>
            ) : (
              props.projects.slice(0, 4).map((p2) => (
                <span key={p2.id} className="welcome-example-pill">{p2.name}</span>
              ))
            )}
          </div>
        </div>

        {result && (
          <section className="route-card">
            {result.decision === 'none' && (
              <p>
                我没有找到匹配的项目。请更具体地说是哪个项目，我不会硬猜。
              </p>
            )}

            {result.decision === 'ambiguous' && (
              <>
                <p>有几个项目同样可能，请你选一个：</p>
                <ul className="route-list">
                  {result.candidates.map((c) => (
                    <li key={c.projectId}>
                      <button
                        type="button"
                        className="route-item"
                        onClick={() => void handoff(c.projectId, c.name)}
                        disabled={busy}
                      >
                        <span className="route-name">{c.name}</span>
                        <span className="route-score">分数 {c.score}</span>
                      </button>
                      <ul className="route-reasons">
                        {c.reasons.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {result.decision === 'unique' && result.candidates[0] && (
              <>
                <p>应该是这个项目：</p>
                <div className="route-unique">
                  <strong>{result.candidates[0].name}</strong>
                  <ul className="route-reasons">
                    {result.candidates[0].reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
                <div className="route-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() =>
                      void handoff(result.candidates[0]!.projectId, result.candidates[0]!.name)
                    }
                    disabled={busy}
                  >
                    把原话转交给它
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => props.onOpenAssistant(result.candidates[0]!.projectId)}
                  >
                    直接打开项目
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {handoffNote && <p className="notice">{handoffNote}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>

      <div className="composer">
        {/* **和主对话用同一套结构**（.composer-box + .composer-bar）。
            之前这里是 `.composer > textarea`，少了 box 这一层，
            所以输入框是一条裸线，和主对话、Agent 页都不一样。 */}
        <div className="composer-box">
          <textarea
            value={query}
            placeholder="比如：把文档那件事推进一下"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            rows={3}
          />
          <div className="composer-bar">
            <div className="composer-left" />
            <button type="button" className="primary small" onClick={() => void ask()} disabled={busy || !query.trim()}>
              帮我找
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
