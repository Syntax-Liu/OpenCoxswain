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
import type { ExecutorDto, MessageDto, OutboundEvent } from './api.js';
import { ApiClient, EventStream } from './api.js';
import {
  applyEvent,
  applySnapshot,
  initialState,
  visibleExecutors,
  type AppState,
} from './state.js';
import { Composer } from './components/Composer.js';
import { ProjectSwitcher } from './components/ProjectSwitcher.js';
import { RunnerPanel } from './components/RunnerPanel.js';
import { Transcript } from './components/Transcript.js';
import { ExecutorFocus } from './components/ExecutorFocus.js';

type View = { readonly kind: 'chat' } | { readonly kind: 'executor'; readonly id: string };

export function App(): JSX.Element {
  const [state, setState] = useState<AppState>(initialState);
  const [view, setView] = useState<View>({ kind: 'chat' });
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

  const executors = useMemo(() => visibleExecutors(state.executors), [state.executors]);
  const currentProject = useMemo(
    () => state.projects.find((p) => p.id === state.currentProjectId) ?? null,
    [state.projects, state.currentProjectId],
  );

  /** 面板只在有执行者时出现——新旧界面最大的结构差异。 */
  const showPanel = executors.length > 0;

  const send = useCallback(
    async (text: string) => {
      const pid = state.currentProjectId;
      if (!pid) return;
      const optimistic: MessageDto = {
        id: `local-${Date.now()}`,
        role: 'user',
        content: text,
        source: 'user',
        at: Date.now(),
      };
      setState((s) => ({ ...s, messages: [...s.messages, optimistic] }));
      try {
        await api.say(pid, text);
      } catch {
        // 失败会通过事件流反映成系统消息，这里不吞
      }
    },
    [api, state.currentProjectId],
  );

  const openExecutor = useCallback((id: string) => setView({ kind: 'executor', id }), []);
  const backToChat = useCallback(() => setView({ kind: 'chat' }), []);

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
      </header>

      <div className={`body${showPanel ? ' has-panel' : ''}`}>
        <main className="main">
          {connecting ? (
            <div className="empty">
              <p className="empty-hint">正在连接本地运行时…</p>
            </div>
          ) : !currentProject ? (
            <EmptyNoProject />
          ) : view.kind === 'executor' ? (
            <ExecutorFocus
              executorId={view.id}
              executors={executors}
              onBack={backToChat}
            />
          ) : (
            <Transcript messages={state.messages} />
          )}

          {currentProject && view.kind === 'chat' && (
            <Composer onSend={(t) => void send(t)} />
          )}
        </main>

        {showPanel && (
          <RunnerPanel executors={executors} onOpen={openExecutor} onDecide={openExecutor} />
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
