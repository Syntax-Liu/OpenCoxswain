/**
 * 应用外壳（重构版）。
 *
 * 结构：头部 + 两区（主区对话 / 跑道面板）
 *
 * 与旧界面的区别：
 *   - **没有左栏**：项目切换在头部下拉；
 *   - **面板不常驻**：没有执行者时整块不渲染，主区自动占满；
 *   - **App.tsx 不再是什么都管的上帝组件**（旧版 1288 行）。
 *
 * 数据层沿用旧实现的类型与纯函数（applySnapshot / applyEvent），
 * 它们经过 698 条测试验证，不需要重写。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDto, ExecutorDto, MessageDto, OutboundEvent } from './api.js';
import { ApiClient, EventStream } from './api.js';
import {
  applyEvent,
  applySnapshot,
  initialState,
  visibleExecutors,
  type AppState,
} from './state.js';
import { ApprovalPanel } from './components/ApprovalPanel.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Composer } from './components/Composer.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';
import { RunnerPanel } from './components/RunnerPanel.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { Transcript } from './components/Transcript.js';
import { TraceView } from './components/TraceView.js';

type View = { readonly kind: 'chat' } | { readonly kind: 'executor'; readonly id: string };

export function App(): JSX.Element {
  const [state, setState] = useState<AppState>(initialState);
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [approvals, setApprovals] = useState<readonly ApprovalDto[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connecting, setConnecting] = useState(true);
  // 连接状态三态：未知（首帧）/ 已连 / 已断。
  // 只有**曾经连上过**再断开才报"离线"——否则首帧会闪一下错误提示。
  const [everConnected, setEverConnected] = useState(false);
  const [connected, setConnected] = useState(false);

  const api = useMemo(() => new ApiClient(), []);
  const streamRef = useRef<EventStream | null>(null);

  // ---- 首次加载：项目列表 ----
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const snapshot = await api.listProjects();
        if (!alive) return;
        setState((s) => {
          const next = applySnapshot(s, snapshot);
          // 没有当前项目时自动选第一个——否则界面永远停在"还没有打开项目"
          const current =
            next.currentProjectId ?? snapshot.projects[0]?.id ?? null;
          return { ...next, currentProjectId: current };
        });
        setConnecting(false);
      } catch {
        if (alive) setConnecting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  // ---- 事件流 ----
  useEffect(() => {
    const stream = new EventStream('', {
      onEvent: (item: OutboundEvent) =>
        setState((s) => applyEvent(s, item.seq, item.event)),
      onGap: () => {
        // 断流：重新拉一次快照
        void api.listProjects().then((snap) => setState((s) => applySnapshot(s, snap)));
      },
      onStatus: (ok) => {
        setConnected(ok);
        if (ok) setEverConnected(true);
      },
    });
    streamRef.current = stream;
    stream.start();
    return () => stream.close();
  }, [api]);

  // ---- 切项目时拉消息 + 执行者 ----
  useEffect(() => {
    const pid = state.currentProjectId;
    if (!pid) return;
    let alive = true;
    void (async () => {
      try {
        const [detail, msg] = await Promise.all([
          api.projectDetail(pid),
          api.messages(pid),
        ]);
        if (!alive) return;
        setState((s) => ({
          ...s,
          executors: detail.executors,
          messages: msg.messages,
        }));
        streamRef.current?.setLastSeq(msg.lastSeq);
      } catch {
        // 拉取失败时保留现有数据，不清空界面
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, state.currentProjectId]);

  // ---- 审批：定时拉取（审批有时效，不能只靠事件） ----
  useEffect(() => {
    const pid = state.currentProjectId;
    if (!pid) return;
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await api.approvals(pid);
        if (alive) setApprovals(r.approvals);
      } catch {
        // 拉不到就保留上一次的结果，不清空
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, state.currentProjectId]);

  const decideApproval = useCallback(
    async (id: string, decision: 'approve' | 'reject', reason?: string) => {
      // 先本地移除，避免用户点了两次
      setApprovals((list) => list.filter((a) => a.id !== id));
      try {
        if (decision === 'approve') await api.approve(id, reason);
        else await api.reject(id, reason ?? '');
      } catch {
        // 失败时重新拉一次，让状态回到真实值
        const pid = state.currentProjectId;
        if (pid) {
          const r = await api.approvals(pid).catch(() => null);
          if (r) setApprovals(r.approvals);
        }
      }
    },
    [api, state.currentProjectId],
  );

  // ---- 快捷键：Ctrl+K 命令面板，Ctrl+, 设置，Esc 逐层关闭 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        return;
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, paletteOpen]);

  const executors = useMemo(() => visibleExecutors(state.executors), [state.executors]);
  const currentProject = useMemo(
    () => state.projects.find((p) => p.id === state.currentProjectId) ?? null,
    [state.projects, state.currentProjectId],
  );

  /** 面板只在有执行者时出现——新旧界面最大的结构差异。 */
  const showPanel = executors.length > 0;

  const send = useCallback(
    async (
      text: string,
      images: readonly { type: 'image'; dataUrl: string; name: string }[] = [],
    ) => {
      const pid = state.currentProjectId;
      if (!pid) return;
      const optimistic: MessageDto = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
        source: 'user',
        at: Date.now(),
        ...(images.length > 0 ? { images } : {}),
      };
      setState((s) => ({ ...s, messages: [...s.messages, optimistic] }));
      try {
        await api.say(pid, text, images.length > 0 ? images : undefined);
      } catch {
        // 失败会通过事件流反映成系统消息，这里不吞
      }
    },
    [api, state.currentProjectId],
  );

  const openExecutor = useCallback((id: string) => setView({ kind: 'executor', id }), []);
  const backToChat = useCallback(() => setView({ kind: 'chat' }), []);

  /** 在跑的 Agent 数（含启动中）——决定要不要显示「停止全部」。 */
  const runningCount = useMemo(
    () => executors.filter((e) => e.status === 'starting' || e.status === 'running').length,
    [executors],
  );

  /**
   * 用户叫停：**级联**，不是"让 Assistant 闭嘴"。
   * 后端会把 Assistant 当前这一轮和所有在跑/排队的 Agent 一起取消。
   * 失败必须可见——这是"点了停止却没停"的唯一防线。
   */
  const [stopError, setStopError] = useState<string | null>(null);
  const stopAll = useCallback(async () => {
    const pid = state.currentProjectId;
    if (!pid) return;
    setStopError(null);
    try {
      const r = await api.stop(pid);
      // 后端会推 executor_settled，跑道会自己变成已取消；这里只兜底报错。
      if (r.failedExecutors && r.failedExecutors > 0) {
        setStopError(`${r.failedExecutors} 个 Agent 没能停下，请再看一眼跑道。`);
      }
    } catch (error) {
      setStopError(
        `没能停下：${error instanceof Error ? error.message : String(error)}。它们可能还在跑。`,
      );
    }
  }, [api, state.currentProjectId]);

  return (
    <div className="shell">
      <header className="head">
        {/* 品牌名只在**没有项目**时显示。
            有项目时，头部的主角是项目名——重复两次产品名是最刺眼的观感问题。
            （旧界面正是栽在这里，新界面沿用同一修法） */}
        {!currentProject && (
          <span className="head-brand">
            <span className="head-mark" aria-hidden />
            OpenCoxswain
          </span>
        )}
        {!currentProject && <span className="head-sep" aria-hidden />}
        <ProjectSwitcher
          projects={state.projects}
          current={currentProject}
          onPick={(id) => {
            setState((s) => ({ ...s, currentProjectId: id }));
            setView({ kind: 'chat' });
          }}
        />
        {currentProject && (
          <span className="head-project-path" title={currentProject.rootPath}>
            {currentProject.rootPath}
          </span>
        )}
        <span className="head-spacer" />
        {!connected && everConnected && (
          <span className="chip chip--failed" title="与本地运行时断开，正在重连">
            离线
          </span>
        )}
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={() => setSettingsOpen(true)}
          title="设置（Ctrl+,）"
          aria-label="设置"
        >
          ⚙
        </button>
      </header>

      {paletteOpen && (
        <CommandPalette
          projects={state.projects}
          executors={executors}
          onClose={() => setPaletteOpen(false)}
          onPickProject={(id) => {
            setState((s) => ({ ...s, currentProjectId: id }));
            setView({ kind: 'chat' });
          }}
          onOpenExecutor={openExecutor}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {settingsOpen && (
        <div
          className="settings-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <SettingsPanel
            onClose={() => setSettingsOpen(false)}
            onChanged={() => {
              // 配置变了，重新拉一次项目列表
              void api.listProjects().then((snap) => setState((s) => applySnapshot(s, snap)));
            }}
          />
        </div>
      )}

      <div className={`body${showPanel ? ' has-panel' : ''}`}>
        <main className="main">
          {/* 审批置顶：它是阻塞性的，且有时效，必须比对话更醒目 */}
          <ApprovalPanel
            approvals={approvals}
            onApprove={(id) => void decideApproval(id, 'approve')}
            onReject={(id, reason) => void decideApproval(id, 'reject', reason)}
          />

          {connecting ? (
            <div className="empty">
              <p className="empty-hint">正在连接本地运行时…</p>
            </div>
          ) : !currentProject ? (
            <EmptyNoProject />
          ) : view.kind === 'executor' ? (
            (() => {
              const target = executors.find((e) => e.id === view.id);
              return target ? (
                <TraceView executor={target} onBack={backToChat} />
              ) : (
                <div className="empty">
                  <p className="empty-hint">这个执行者已经不在列表里了。</p>
                  <button type="button" className="btn btn--secondary btn--md" onClick={backToChat}>
                    返回对话
                  </button>
                </div>
              );
            })()
          ) : (
            <Transcript
              messages={state.messages}
              onRetry={() => {
                // 重试 Assistant：把最后一条用户消息再发一次。
                // 语义是「再试一次」，不删历史——轨迹可回看是这个产品的承诺。
                const lastUser = [...state.messages]
                  .reverse()
                  .find((m) => m.role === 'user');
                if (lastUser) void send(lastUser.content);
              }}
              onEditResend={(message, next) => {
                void send(next);
                setState((s) => ({
                  ...s,
                  messages: s.messages.map((m) =>
                    m.id === message.id ? { ...m, content: next } : m,
                  ),
                }));
              }}
            />
          )}

          {currentProject && view.kind === 'chat' && (
            <>
              {stopError && (
                <p className="composer-error" role="alert">
                  {stopError}
                </p>
              )}
              <Composer
                projectId={currentProject.id}
                onSend={(t, imgs) => void send(t, imgs)}
                onStop={() => void stopAll()}
                runningCount={runningCount}
              />
            </>
          )}
        </main>

        {showPanel && (
          <RunnerPanel
            executors={executors}
            onOpen={openExecutor}
            onAnswer={(executorId, text) => {
              // 回答经由 C 转达：接口层没有「直接给某个 D 传话」的入口，
              // 这就是架构规定的通道——C 负责把用户的话派给正确的 D。
              const label = executors.find((e) => e.id === executorId)?.label ?? '执行者';
              void send(`关于「${label}」：${text}`);
            }}
          />
        )}
      </div>
    </div>
  );
}

function EmptyNoProject(): JSX.Element {
  return (
    <div className="empty">
      <h2 className="empty-title">还没有打开项目</h2>
      <p className="empty-hint">
        打开一个工作目录，就可以直接对它说你要做什么。
        <br />
        Agent 会在那个目录里干活，你在右边看进度。
      </p>
    </div>
  );
}

export type { ExecutorDto };
