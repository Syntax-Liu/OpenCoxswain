/**
 * 工作台主界面。
 *
 * 结构对齐主流 Agent 软件（DeepSeek / TRAE）：
 *
 * ```
 * ┌────────────┬────────────────────────────┐
 * │ B Supervisor  │                            │
 * │ 添加项目    │      主区                  │
 * │ ─────────  │  · 进项目 → 与 Assistant 对话       │
 * │ 工作区      │  · 点某条 → 看 / 续聊 D     │
 * │ ◇ 项目      │  · 点 B → 跨项目路由        │
 * │   · 对话  │                            │
 * └────────────┴────────────────────────────┘
 * ```
 *
 * 关键映射（用户的原话）：
 * - **点文件夹 = 进入 C**（Assistant，项目的主人）
 * - **点对话 = 某个 Agent**（执行者，可看完整轨迹并继续追问）
 * - **B 单独入口**，只在多项目迷路时用
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiClient,
  EventStream,
  type ApprovalDto,
  type ExecutorDto,
  type ProjectDto,
  type SettingsStatus,
  type SideEffectDto,
  type MemoryCandidateDto,
} from './api.js';
import {
  applyEvent,
  applySnapshot,
  appendUserMessage,
  initialState,
  type AppState,
} from './state.js';
import { Sidebar } from './components/Sidebar.js';
import { Conversation } from './components/Conversation.js';
import { ExecutorChat } from './components/ExecutorChat.js';
import { GlobalAssistant } from './components/GlobalAssistant.js';
import { ApprovalPanel } from './components/ApprovalPanel.js';
import { MemoryReview } from './components/MemoryReview.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { TemplatePicker } from './components/TemplatePicker.js';
import { TitleBar } from './components/TitleBar.js';
import { ContextMenu } from './components/ContextMenu.js';
import { OpenProjectDialog } from './components/OpenProjectDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';

type View =
  | { readonly kind: 'assistant'; readonly projectId: string }
  | { readonly kind: 'executor'; readonly projectId: string; readonly executorId: string }
  | { readonly kind: 'global' };

export function App(): JSX.Element {
  const api = useMemo(() => new ApiClient(), []);
  const [state, setState] = useState<AppState>(initialState);
  const [view, setView] = useState<View | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<SettingsStatus | null>(null);
  const [transcript, setTranscript] = useState<{
    executorId: string | null;
    messages: import('./api.js').MessageDto[];
    loading: boolean;
  }>({ executorId: null, messages: [], loading: false });

  /** 待审批的危险动作。轮询获取——审批是人工操作，不需要 SSE 高频推送。 */
  const [approvals, setApprovals] = useState<ApprovalDto[]>([]);
  /** 当前查看的执行者的副作用台账。 */
  const [effects, setEffects] = useState<SideEffectDto[]>([]);
  /** 记忆候选。 */
  const [memories, setMemories] = useState<MemoryCandidateDto[]>([]);
  const [activeMemories, setActiveMemories] = useState<{
    global: Array<{ id: string; kind: string; text: string; source: string }>;
    project: Array<{ id: string; kind: string; text: string; source: string }>;
  }>({ global: [], project: [] });
  const [extracting, setExtracting] = useState(false);
  /** 模板填入的草稿；带时间戳，保证重复点同一个模板也会生效。 */
  const [draftSeed, setDraftSeed] = useState<{ text: string; at: number } | null>(null);

  const streamRef = useRef<EventStream | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setError = useCallback((message: string | null) => {
    setState((s) => ({ ...s, error: message }));
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setState((s) => applySnapshot(s, { projects: list.projects, lastSeq: list.lastSeq }));
    return list.projects;
  }, [api]);

  const refreshProject = useCallback(
    async (projectId: string) => {
      const detail = await api.projectDetail(projectId);
      const messages = await api.messages(projectId);
      setState((s) =>
        applySnapshot(s, {
          messages: messages.messages,
          executors: detail.executors,
          reports: detail.reports,
          lastSeq: Math.max(detail.lastSeq, messages.lastSeq),
        }),
      );
    },
    [api],
  );

  const openAssistant = useCallback(
    async (projectId: string) => {
      setState((s) => ({ ...s, currentProjectId: projectId }));
      setView({ kind: 'assistant', projectId });
      try {
        await refreshProject(projectId);
      } catch (error) {
        setError(error instanceof Error ? error.message : '读取项目失败');
      }
    },
    [refreshProject, setError],
  );

  const openExecutor = useCallback(
    async (projectId: string, executorId: string) => {
      setState((s) => ({ ...s, currentProjectId: projectId }));
      setView({ kind: 'executor', projectId, executorId });
      setTranscript({ executorId, messages: [], loading: true });
      setEffects([]);
      try {
        const detail = await api.executorMessages(executorId);
        setTranscript({ executorId, messages: detail.messages, loading: false });
        const ledger = await api.executorEffects(executorId);
        setEffects(ledger.effects);
      } catch (error) {
        setTranscript({ executorId, messages: [], loading: false });
        setError(error instanceof Error ? error.message : '读取执行记录失败');
      }
    },
    [api, setError],
  );

  // 首次加载
  useEffect(() => {
    void (async () => {
      try {
        const status = await api.settings();
        setSettings(status);
        if (!status.configured) return;
        const projects = await refreshProjects();
        const first = projects[0];
        if (first) await openAssistant(first.id);
        else setView({ kind: 'global' });
      } catch (error) {
        setError(error instanceof Error ? error.message : '无法连接运行时');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SSE
  useEffect(() => {
    const stream = new EventStream('', {
      onEvent: (item) => {
        setState((s) => applyEvent(s, item.seq, item.event));
        // 正在看某个 Agent 时，它结算了就重拉轨迹。
        const current = stateRef.current;
        if (
          item.event.type === 'executor_settled' &&
          view?.kind === 'executor' &&
          item.event.executor.id === view.executorId
        ) {
          void api
            .executorMessages(view.executorId)
            .then((detail) =>
              setTranscript({ executorId: view.executorId, messages: detail.messages, loading: false }),
            )
            .catch(() => {});
        }
        void current;
      },
      onGap: (reason) => {
        void refreshProjects();
        const p = stateRef.current.currentProjectId;
        if (p) void refreshProject(p);
        setError(`事件流出现缺口（${reason}），已重新同步。`);
      },
      onStatus: (connected, detail) => {
        setState((s) => ({ ...s, connected, connectionDetail: detail ?? null }));
      },
    });
    streamRef.current = stream;
    stream.start();
    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    streamRef.current?.setLastSeq(state.appliedSeq);
  }, [state.appliedSeq]);

  // 审批轮询：每 3 秒问一次有没有新的待审批动作。
  // 有执行者正在跑时才轮询，空闲时不打扰后端。
  useEffect(() => {
    const projectId = view && view.kind !== 'global' ? view.projectId : state.currentProjectId;
    if (!projectId) return;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const result = await api.approvals(projectId);
        if (!cancelled) setApprovals(result.approvals);
      } catch {
        // 拉不到不影响主流程
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, view, state.currentProjectId]);

  const handleApprove = useCallback(
    async (approvalId: string, reason: string) => {
      try {
        await api.approve(approvalId, reason);
        setApprovals((list) => list.map((a) => (a.id === approvalId ? { ...a, status: 'approved' } : a)));
      } catch (error) {
        setError(error instanceof Error ? error.message : '批准失败');
      }
    },
    [api, setError],
  );

  const handleReject = useCallback(
    async (approvalId: string, reason: string) => {
      try {
        await api.reject(approvalId, reason);
        setApprovals((list) => list.map((a) => (a.id === approvalId ? { ...a, status: 'rejected' } : a)));
      } catch (error) {
        setError(error instanceof Error ? error.message : '拒绝失败');
      }
    },
    [api, setError],
  );

  // 记忆候选：进入项目时拉一次
  const activeProjectId = view && view.kind !== 'global' ? view.projectId : state.currentProjectId;
  useEffect(() => {
    if (!activeProjectId) return;
    let cancelled = false;
    void api
      .memories(activeProjectId)
      .then((r) => {
        if (!cancelled) setMemories(r.candidates);
      })
      .catch(() => {});
    // 已生效的记忆也要拉一次：用户得能看见"它到底记住了什么"。
    void api
      .memoryList(activeProjectId)
      .then((r) => {
        if (!cancelled) setActiveMemories(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, activeProjectId]);

  const refreshActiveMemories = useCallback(
    async (projectId: string) => {
      try {
        setActiveMemories(await api.memoryList(projectId));
      } catch {
        // 记忆读不到不影响主流程
      }
    },
    [api],
  );

  const handleExtract = useCallback(async () => {
    if (!activeProjectId) return;
    setExtracting(true);
    try {
      const result = await api.extractMemories(activeProjectId);
      setMemories(result.candidates);
      if (result.created === 0) {
        setError('这次没有提炼出值得记住的内容。');
      } else {
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '提炼失败');
    } finally {
      setExtracting(false);
    }
  }, [api, activeProjectId, setError]);

  const handleAcceptMemory = useCallback(
    async (id: string) => {
      try {
        await api.acceptMemory(id);
        setMemories((list) => list.map((c) => (c.id === id ? { ...c, status: 'accepted' } : c)));
        // 采纳后立刻刷新"已生效"，用户能马上看到那条记忆进去了。
        if (activeProjectId) await refreshActiveMemories(activeProjectId);
      } catch (err) {
        setError(err instanceof Error ? err.message : '采纳失败');
      }
    },
    [api, setError, activeProjectId, refreshActiveMemories],
  );

  const handleDismissMemory = useCallback(
    async (id: string) => {
      try {
        await api.dismissMemory(id);
        setMemories((list) => list.map((c) => (c.id === id ? { ...c, status: 'dismissed' } : c)));
      } catch (err) {
        setError(err instanceof Error ? err.message : '忽略失败');
      }
    },
    [api, setError],
  );

  const handleForgetMemory = useCallback(

    async (scope: 'global' | 'project', entryId: string) => {
      if (!activeProjectId) return;
      try {
        await api.forgetMemory(activeProjectId, scope, entryId);
        setActiveMemories((prev) => ({
          ...prev,
          [scope]: prev[scope].filter((e) => e.id !== entryId),
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : '删除失败');
      }
    },
    [api, activeProjectId, setError],
  );

  const handleOpenProject = useCallback(
    async (rootPath: string, name?: string) => {
      setShowOpen(false);
      try {
        const { project } = await api.openProject({ rootPath, ...(name ? { name } : {}) });
        await refreshProjects();
        await openAssistant(project.id);
      } catch (error) {
        setError(error instanceof Error ? error.message : '打开项目失败');
      }
    },
    [api, refreshProjects, openAssistant, setError],
  );

  const handleSendToAssistant = useCallback(
    async (text: string) => {
      if (view?.kind !== 'assistant') return;
      setState((s) => ({
        ...s,
        messages: appendUserMessage(s.messages, text),
        thinking: true,
      }));
      try {
        await api.say(view.projectId, text);
      } catch (error) {
        setState((s) => ({ ...s, thinking: false }));
        setError(error instanceof Error ? error.message : '发送失败');
      }
    },
    [api, view, setError],
  );

  /** 用户直接对某个 Agent 追问。 */
  const handleSendToExecutor = useCallback(
    async (text: string) => {
      if (view?.kind !== 'executor') return;
      const { executorId } = view;
      setTranscript((t) => ({
        ...t,
        messages: [...t.messages, {
          id: `local_${Date.now()}`,
          role: 'user',
          content: text,
          source: 'webapp',
          at: Date.now(),
        }],
      }));
      try {
        await api.sayToExecutor(executorId, text);
        const detail = await api.executorMessages(executorId);
        setTranscript({ executorId, messages: detail.messages, loading: false });
        const p = stateRef.current.currentProjectId;
        if (p) await refreshProject(p);
      } catch (error) {
        setError(error instanceof Error ? error.message : '追问失败');
      }
    },
    [api, view, refreshProject, setError],
  );

  const handleStop = useCallback(async () => {
    if (view?.kind !== 'assistant') return;
    try {
      await api.stop(view.projectId);
    } catch (error) {
      setError(error instanceof Error ? error.message : '停止失败');
    }
  }, [api, view, setError]);

  const currentProject =
    (view && view.kind !== 'global'
      ? state.projects.find((p) => p.id === view.projectId)
      : state.projects.find((p) => p.id === state.currentProjectId)) ?? null;

  const currentExecutor: ExecutorDto | null =
    view?.kind === 'executor'
      ? (state.executors.find((e) => e.id === view.executorId) ?? null)
      : null;

  // 标题栏的路径提示：像 VS Code 的标签页，告诉你在哪。
  const titleCrumb = currentExecutor
    ? `${currentProject?.name ?? ''} / ${currentExecutor.label}`
    : view?.kind === 'global'
      ? 'Supervisor'
      : (currentProject?.name ?? '未打开项目');

  const needsSetup = settings !== null && !settings.configured;
  if (needsSetup) {
    return (
      <div className="app-shell setup-shell">
        <SetupScreen
          api={api}
          status={settings}
          onSaved={(next) => {
            setSettings(next);
            void refreshProjects().then((projects) => {
              if (projects[0]) void openAssistant(projects[0].id);
              else setView({ kind: 'global' });
            });
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-root">
      {/* 自绘标题栏：替代系统标题栏，去掉顶部那条割裂的框 */}
      <TitleBar crumb={titleCrumb} />
      <div className="app-shell">
      <Sidebar
        projects={state.projects}
        executors={state.executors}
        currentProjectId={state.currentProjectId}
        view={view ?? { kind: 'global' }}
        connected={state.connected}
        connectionDetail={state.connectionDetail}
        onOpenAssistant={(id) => void openAssistant(id)}
        onOpenExecutor={(pid, eid) => void openExecutor(pid, eid)}
        onOpenGlobal={() => setView({ kind: 'global' })}
        onOpenProject={() => setShowOpen(true)}
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="main">
        <UpdateBanner api={api} />
        <ApprovalPanel
          approvals={approvals}
          onApprove={(id, reason) => void handleApprove(id, reason)}
          onReject={(id, reason) => void handleReject(id, reason)}
        />
        {view?.kind === 'global' && (
          <GlobalAssistant api={api} projects={state.projects} onOpenAssistant={(id) => void openAssistant(id)} />
        )}

        {view?.kind === 'assistant' && currentProject && (
          <Conversation
            project={currentProject as ProjectDto}
            messages={state.messages}
            thinking={state.thinking}
            memoryReview={
              <MemoryReview
                candidates={memories}
                active={activeMemories}
                busy={extracting}
                onExtract={() => void handleExtract()}
                onAccept={(id) => void handleAcceptMemory(id)}
                onDismiss={(id) => void handleDismissMemory(id)}
                onForget={(scope, id) => void handleForgetMemory(scope, id)}
              />
            }
            templatePicker={
              <TemplatePicker
                api={api}
                onPick={(applied) => {
                  // 模板只把话写好——**还是要用户自己点发送**。
                  setDraftSeed({ text: `${applied.label}\n${applied.goal}`, at: Date.now() });
                }}
              />
            }
            {...(draftSeed ? { draftSeed } : {})}
            onSend={(text) => void handleSendToAssistant(text)}
            onStop={() => void handleStop()}
          />
        )}

        {view?.kind === 'executor' && currentExecutor && (
          <ExecutorChat
            executor={currentExecutor}
            messages={transcript.executorId === view.executorId ? transcript.messages : []}
            effects={effects}
            loading={transcript.loading}
            onSend={(text) => void handleSendToExecutor(text)}
            onCancel={() => void api.cancelExecutor(view.executorId).catch(() => {})}
            onBack={() => void openAssistant(view.projectId)}
          />
        )}

        {!view && <div className="empty">正在加载…</div>}
      </main>

      {showOpen && (
        <OpenProjectDialog
          onCancel={() => setShowOpen(false)}
          onConfirm={(rootPath, name) => void handleOpenProject(rootPath, name)}
        />
      )}

      {showSettings && settings && (
        <SettingsDialog
          api={api}
          status={settings}
          projects={state.projects}
          onClose={() => setShowSettings(false)}
          onSaved={setSettings}
        />
      )}

      {state.error && (
        <div className="toast" role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}
      </div>
      {/* 自定义右键菜单：替换浏览器默认菜单 */}
      <ContextMenu />
    </div>
  );
}

/** 首次启动引导：填模型密钥。 */
function SetupScreen({
  api,
  status,
  onSaved,
}: {
  api: ApiClient;
  status: SettingsStatus;
  onSaved: (status: SettingsStatus) => void;
}): JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [model, setModel] = useState(status.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!apiKey.trim()) {
      setError('请填写 API Key');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.saveSettings({
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          model: model.trim(),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <h1>OpenCoxswain · 舵手</h1>
      <p className="muted">
        最后一步：填一个模型密钥。它只保存在本机
        <code>~/.opencoxswain/llm.json</code>，不会上传。
      </p>

      <label className="field">
        <span>API Key</span>
        <input
          autoFocus
          type="password"
          value={apiKey}
          placeholder="sk-..."
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </label>

      <details className="advanced">
        <summary>高级设置（端点 / 模型）</summary>
        <label className="field">
          <span>端点</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>模型</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
      </details>

      {error && <p className="form-error">{error}</p>}

      <button type="button" className="primary wide" onClick={() => void submit()} disabled={busy}>
        {busy ? '保存中…' : '开始使用'}
      </button>
    </div>
  );
}
