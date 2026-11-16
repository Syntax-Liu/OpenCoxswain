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
 * - **点对话 = 某个 Agent**（Agent，可看完整轨迹并继续追问）
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
import { readIconTheme, writeIconTheme } from './iconTheme.js';
import { DecisionPanel } from './components/DecisionPanel.js';
import { RailEmptyState, RightRail } from './components/RightRail.js';
import { ProjectPicker } from './components/ProjectPicker.js';
import { NewSession } from './components/NewSession.js';
import { ExecutorChat } from './components/ExecutorChat.js';
import { GlobalAssistant } from './components/GlobalAssistant.js';
import { ApprovalPanel } from './components/ApprovalPanel.js';
import { MemoryReview } from './components/MemoryReview.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { formatTokens } from './metrics.js';
import type { MessageDto } from './api.js';
import { readSavedSidebarWidth, saveSidebarWidth } from './sidebarWidth.js';
import { CommandPalette, type PaletteItem } from './components/CommandPalette.js';
import { resolveShortcut } from './shortcuts.js';
import { ERROR_KIND_LABEL, classifyError } from './components/errorDisplay.js';
import { TemplatePicker } from './components/TemplatePicker.js';
import { TitleBar } from './components/TitleBar.js';
import { OpenProjectDialog } from './components/OpenProjectDialog.js';
import { SettingsPage } from './components/SettingsPage.js';
import { draftKey } from './drafts.js';

type View =
  | { readonly kind: 'assistant'; readonly projectId: string }
  | { readonly kind: 'executor'; readonly projectId: string; readonly executorId: string }
  | { readonly kind: 'global' }
  /**
   * 新会话：**空页，还没选项目**。
   *
   * 用户原话：
   * > "新会话"和"添加项目"这两个的作用是一样的，只保留"新会话"，
   * > 然后在对话框附近选择项目
   *
   * 所以点「新会话」不再直接跳第一个项目，而是进这里——
   * 项目在输入框旁边的选择器里定。
   */
  | { readonly kind: 'new' };

export function App(): JSX.Element {
  const api = useMemo(() => new ApiClient(), []);
  const [state, setState] = useState<AppState>(initialState);
  const [view, setView] = useState<View | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * 成功操作的轻量提示。
   *
   * **和 error 分开**：成功提示不该显示成红色警告卡片，
   * 用户会以为出事了。之前移除项目就是把成功文案塞进 setError。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /** 当前错误的分类结果（null 表示没有错误）。 */
  const errorInfo = state.error ? classifyError(state.error) : null;

  // 成功提示 4 秒后自动消失（错误不自动消失——错误是事实，用户自己关）
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  /** 侧栏折叠（Ctrl+B）。独立于宽度——折叠不是把宽度设成 0。 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /**
   * 应用图标配色。
   *
   * 存在 localStorage（同步读，首屏不会闪旧图标）；
   * Rust 侧启动时读同一个键，窗口和托盘图标也跟着变。
   */
  const [iconTheme, setIconTheme] = useState<string>(() => readIconTheme());
  const pickIconTheme = useCallback(
    (id: string) => {
      // 1. 先更新界面（同步，点了立刻变）
      setIconTheme(writeIconTheme(id));
      // 2. 再落一份给壳层——窗口和托盘图标是 Rust 画的，
      //    它们读不到 localStorage。失败不影响界面（下次启动
      //    壳层会退回紫罗兰），所以只记录不打断。
      void api.setIconTheme(id).catch(() => {});
    },
    [api],
  );
  /** 命令面板（Ctrl+K）。 */
  const [showPalette, setShowPalette] = useState(false);
  const [settings, setSettings] = useState<SettingsStatus | null>(null);
  const [transcript, setTranscript] = useState<{
    executorId: string | null;
    messages: import('./api.js').MessageDto[];
    loading: boolean;
  }>({ executorId: null, messages: [], loading: false });

  /** 待审批的危险动作。轮询获取——审批是人工操作，不需要 SSE 高频推送。 */
  const [approvals, setApprovals] = useState<ApprovalDto[]>([]);
  /** 当前查看的Agent 的副作用台账。 */
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
  /** 侧栏宽度；由 Sidebar 拖动时上报，用于同步网格列宽。 */
  /**
   * 侧栏宽度。
   *
   * **必须和 Sidebar 用同一个来源**。之前这里写死 244，而侧栏从
   * localStorage 读（可能是 384），两边不一致 —— 重启后网格列压在 244，
   * 侧栏内部却是 384，拖动一次才同步，看起来就是"重启后错位、拖一下就正常"。
   * 现在初始值也从 localStorage 读。
   */
  const [sidebarWidth, setSidebarWidth] = useState(readSavedSidebarWidth);

  /**
   * 右栏宽度和折叠状态。
   *
   * 用户原话：
   * > 决策面板不要常驻在顶上，应该在右边侧边栏打开，就像 DSH 这样
   * > 放在顶上导致下方对话很扁，看不全内容
   *
   * 测过：顶部面板占主区 26%（228 / 870），展开时能到 32vh，
   * 消息区被压到 370px。挪到右栏后，它占的是**宽度**不是高度。
   */
  const [railWidth, setRailWidth] = useState(320);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const streamRef = useRef<EventStream | null>(null);
  const stateRef = useRef(state);

  /**
   * 流式增量的累积缓冲。
   *
   * delta 到达频率远高于屏刷频率（一帧能来十几个），
   * 所以先攒在 ref 里，rAF 每帧统一提交一次。
   */
  const pendingDelta = useRef('');
  /** 这一帧是否已经排了提交。避免一帧内排几十个 rAF。 */
  const rafPending = useRef(false);
  stateRef.current = state;

  const setError = useCallback((message: string | null) => {
    setState((s) => ({ ...s, error: message }));
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api.listProjects();
    setState((s) => applySnapshot(s, { projects: list.projects, lastSeq: list.lastSeq }));
    return list.projects;
  }, [api]);

  /**
   * 加载所有项目的会话列表。
   *
   * **侧栏要能展开任意项目**，所以不能只加载当前项目的。
   * 之前只加载当前项目，展开别的项目是空的——
   * 用户会以为"两个项目不能同时展开"。
   *
   * 并行请求，单个失败不影响其它项目。
   */
  const refreshAllExecutors = useCallback(
    async (projects: readonly ProjectDto[]) => {
      const results = await Promise.all(
        projects.map((p) =>
          api
            .projectDetail(p.id)
            .then((d) => d.executors)
            .catch(() => [] as ExecutorDto[]),
        ),
      );
      const merged = results.flat();
      setState((s) => ({ ...s, executors: merged }));
    },
    [api],
  );

  const refreshProject = useCallback(
    async (projectId: string) => {
      const detail = await api.projectDetail(projectId);
      const messages = await api.messages(projectId);
      setState((s) =>
        applySnapshot(s, {
          messages: messages.messages,
          // **合并而不是替换**。
          //
          // 之前是 `executors: detail.executors`，只保留当前项目的会话，
          // 其它项目的会话被冲掉——侧栏于是展开别的项目也看不到东西，
          // 看起来像"两个项目不能同时展开"。
          //
          // 现在：先用别的项目的旧数据打底，再用当前项目的新数据覆盖。
          executors: [
            ...s.executors.filter((e) => e.projectId !== projectId),
            ...detail.executors,
          ],
          reports: detail.reports,
          lastSeq: Math.max(detail.lastSeq, messages.lastSeq),
        }),
      );
    },
    [api],
  );

  const openAssistant = useCallback(
    async (projectId: string) => {
      // **切项目时立刻清空上一个项目的内容**（2026-11-16 用户反馈）。
      //
      // 现象：新建的空项目里显示了上一个项目的对话。
      //
      // 原因有两个：
      //   1. `messages` 要等 `refreshProject` 的网络请求回来才替换，
      //      中间这段旧内容还挂在屏幕上
      //   2. `streaming`（流式缓冲）和 `thinking` 根本没人清过——
      //      如果切走时正在生成，回来还能看到上一段半截的字
      //
      // 现在：先原子地清掉，再拉新的。宁可闪一下空白，也不能显示错的内容。
      setState((s) => ({
        ...s,
        currentProjectId: projectId,
        messages: [],
        streaming: '',
        thinking: false,
        reports: [],
        error: null,
      }));
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
      // 和 openAssistant 同理：切走时要把上一个项目的对话清掉，
      // 否则再看回主对话会残留错的内容。
      setState((s) => ({
        ...s,
        currentProjectId: projectId,
        streaming: '',
        thinking: false,
      }));
      setView({ kind: 'executor', projectId, executorId });
      setTranscript({ executorId, messages: [], loading: true });
      setEffects([]);
      // 保证主对话里的消息也是这个项目的（切项目时可能还没拉过）。
      try {
        await refreshProject(projectId);
      } catch {
        // 拉不到不影响看 Agent 详情
      }
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
        // 侧栏要能展开任意项目——先把所有项目的会话都拉下来
        await refreshAllExecutors(projects);
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
        // **流式增量按帧提交**（2026-11-16 实测踩到的）。
        //
        // ## 试过但无效的
        //
        // React 18 把同一微任务里的多次 setState 合并。delta 一个 chunk
        // 一个字地来，几十个挤在几毫秒内——浏览器实测：
        //
        //   后端：一次回复 119 个 delta（Node 侧抓 SSE 确认逐条到达）
        //   前端：902 帧采样，流式气泡长度一直是 15，然后直接跳完整
        //
        // `flushSync` 也不行（React 只在同步渲染/事件处理器里强制同步，
        // 这里是异步 SSE 回调）。
        //
        // ## 现在的做法
        //
        // delta 只累积到 ref，**每帧（rAF）统一提交一次**给 state。
        // 既不被批处理吞掉，也不会一帧渲染几十次。
        if (item.event.type === 'assistant_delta') {
          pendingDelta.current += item.event.text;
          const pid = item.event.projectId;
          if (!rafPending.current) {
            rafPending.current = true;
            requestAnimationFrame(() => {
              rafPending.current = false;
              const text = pendingDelta.current;
              if (!text) return;
              pendingDelta.current = '';
              setState((s) =>
                s.currentProjectId === pid
                  ? { ...s, thinking: false, streaming: s.streaming + text }
                  : s,
              );
            });
          }
          return;
        }
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
  // 有Agent正在跑时才轮询，空闲时不打扰后端。
  useEffect(() => {
    const projectId = view && view.kind !== 'global' && view.kind !== 'new' ? view.projectId : state.currentProjectId;
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
  const activeProjectId = view && view.kind !== 'global' && view.kind !== 'new' ? view.projectId : state.currentProjectId;
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

  /**
   * 全局快捷键。
   *
   * 用 window 监听而不是在某个组件上：快捷键要在整个应用范围内生效，
   * 包括焦点在输入框的时候（带修饰键的组合）。
   *
   * 具体键位与"不和输入框抢键"的规则见 shortcuts.ts。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = resolveShortcut({
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      });
      if (!action) return;

      switch (action.type) {
        case 'palette':
          e.preventDefault();
          setShowPalette((v) => !v);
          break;
        case 'new-conversation':
          e.preventDefault();
          setShowPalette(false);
          setShowSettings(false);
          setView({ kind: 'global' });
          break;
        case 'open-settings':
          e.preventDefault();
          setShowPalette(false);
          setShowSettings(true);
          break;
        case 'toggle-sidebar':
          e.preventDefault();
          setSidebarCollapsed((v) => !v);
          break;
        case 'switch-project': {
          const target = state.projects[action.index];
          if (target) {
            e.preventDefault();
            setShowPalette(false);
            void openAssistant(target.id);
          }
          break;
        }
        case 'escape':
          // 按层级关闭：先关命令面板，再关设置，最后才放弃。
          // 一次 Esc 只关一层，避免"一按全关"。
          if (showPalette) setShowPalette(false);
          else if (showSettings) setShowSettings(false);
          else if (showOpen) setShowOpen(false);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [state.projects, openAssistant, showPalette, showSettings, showOpen]);

  /** 命令面板里的条目：项目 + 常用动作。 */
  const paletteItems = useMemo(() => {
    const items: PaletteItem[] = [];

    for (const project of state.projects) {
      items.push({
        id: `project-${project.id}`,
        label: project.name,
        hint: project.displayPath,
        group: '项目',
        run: () => void openAssistant(project.id),
      });
    }

    items.push(
      {
        id: 'action-new',
        label: '新对话',
        hint: 'Ctrl+N',
        group: '动作',
        run: () => setView({ kind: 'global' }),
      },
      {
        id: 'action-project',
        label: '打开项目…',
        group: '动作',
        run: () => setShowOpen(true),
      },
      {
        id: 'action-settings',
        label: '打开设置',
        hint: 'Ctrl+,',
        group: '动作',
        run: () => setShowSettings(true),
      },
      {
        id: 'action-sidebar',
        label: '折叠 / 展开侧栏',
        hint: 'Ctrl+B',
        group: '动作',
        run: () => setSidebarCollapsed((v) => !v),
      },
      {
        id: 'action-global',
        label: '打开 Supervisor',
        group: '动作',
        run: () => setView({ kind: 'global' }),
      },
    );

    return items;
  }, [state.projects, openAssistant]);

  /**
   * 把项目移出工作区。
   *
   * 二次确认是必需的：这个动作虽然**不动磁盘文件**，但项目会从列表里消失，
   * 用户会有一瞬间觉得"东西没了"。明确告诉它文件还在，能消除大部分顾虑。
   */
  const handleRemoveProject = useCallback(
    async (projectId: string) => {
      const project = state.projects.find((p) => p.id === projectId);
      const name = project?.name ?? '这个项目';

      const ok = window.confirm(
        `把「${name}」移出工作区？\n\n` +
          '· 磁盘上的文件**不会**被删除\n' +
          '· 对话记录和轨迹都保留着\n' +
          '· 以后可以重新打开同一个目录',
      );
      if (!ok) return;

      try {
        const result = await api.archiveProject(projectId);
        await refreshProjects();
        // 正开着的就是这个项目 → 退回全局视图
        if (view && view.kind !== 'global' && view.kind !== 'new' && 'projectId' in view && view.projectId === projectId) {
          setView({ kind: 'global' });
        }
        // 这是**成功**提示，不是错误
        setNotice(result.message);
      } catch (error) {
        // 409（有 Agent 在跑）会走到这里，把原因原样展示
        setError(error instanceof Error ? error.message : '移除失败');
      }
    },
    [api, state.projects, view, refreshProjects, setError],
  );

  /**
   * 撤销一次文件写入。
   *
   * 需要二次确认：撤销会**改文件内容**，误点一下就把 Agent 的改动抹了。
   * 确认文案要说清楚"改的是哪个文件"。
   */
  const handleUndoEffect = useCallback(
    async (effectId: string, projectId: string) => {
      const effect = effects.find((e) => e.id === effectId);
      const target = effect?.target ?? '这个文件';

      const ok = window.confirm(
        `把「${target}」恢复到 Agent 改动之前？\n\n` +
          '· 会覆盖 Agent 写入的内容\n' +
          '· 如果之后你又手工改过这个文件，撤销会被拒绝（不会覆盖你的修改）',
      );
      if (!ok) return;

      try {
        const result = await api.undoEffect(effectId, projectId);
        // **成功走 notice**，不是 error——之前这里把成功文案当错误显示
        setNotice(result.message);
        // 重新拉一遍这个 Agent 的详情，让台账状态变成"已撤销"
        await refreshProject(projectId);
        if (view?.kind === 'executor') await openExecutor(projectId, view.executorId);
      } catch (error) {
        setError(error instanceof Error ? error.message : '撤销失败');
      }
    },
    [api, effects, refreshProject, openExecutor, view, setError],
  );

  /**
   * 整轮回滚：把这一轮 Agent 改过的文件全部恢复。
   *
   * 和单条撤销的区别：**不用点 N 次**。
   * 保护逻辑一样——后来被手工改过的文件会被跳过。
   */
  const handleRollbackAll = useCallback(
    async (projectId: string, executorId: string) => {
      const ok = window.confirm(
        '把这一轮 Agent 改过的文件全部恢复到改动之前？\n\n' +
          '· 会覆盖 Agent 写入的内容\n' +
          '· 之后你手工改过的文件会被跳过（不会覆盖你的修改）\n' +
          '· 跑过的命令撤不了，只回滚文件',
      );
      if (!ok) return;

      try {
        const { checkpoints } = await api.checkpoints(executorId, projectId);
        const latest = checkpoints[checkpoints.length - 1];
        if (!latest) {
          setNotice('这一轮没有可回滚的文件改动。');
          return;
        }
        const result = await api.rollbackCheckpoint(executorId, latest.id, projectId);
        setNotice(result.message);
        await refreshProject(projectId);
        if (view?.kind === 'executor') await openExecutor(projectId, view.executorId);
      } catch (error) {
        setError(error instanceof Error ? error.message : '回滚失败');
      }
    },
    [api, refreshProject, openExecutor, view, setError],
  );

  /**
   * 标记一条待决策为已处理。
   *
   * **不删除记录**——用户可能回头查"当时我是怎么决定的"。
   * 只是从"等你决定"的待办里移走。
   */
  const handleAcknowledge = useCallback(
    async (reportId: string) => {
      try {
        await api.acknowledgeReport(reportId);
      } catch (error) {
        setError(error instanceof Error ? error.message : '标记失败');
      }
    },
    [api],
  );

  /** 删除一条会话。正在跑的会被服务端拒绝，这里把原因显示出来。 */
  const handleDeleteExecutor = useCallback(
    async (projectId: string, executorId: string) => {
      try {
        await api.deleteExecutor(executorId);
        // 如果正开着这条会话，退回到项目的 Assistant
        if (view?.kind === 'executor' && view.executorId === executorId) {
          setView({ kind: 'assistant', projectId });
        }
        // 从本地状态里移除，不等下一次快照
        setState((s) => ({
          ...s,
          executors: s.executors.filter((e) => e.id !== executorId),
        }));
      } catch (error) {
        setError(error instanceof Error ? error.message : '删除失败');
      }
    },
    [api, view],
  );

  const handleSendToAssistant = useCallback(
    async (
      text: string,
      images?: readonly { type: 'image'; dataUrl: string; name: string }[],
    ) => {
      if (view?.kind !== 'assistant') return;
      setState((s) => ({
        ...s,
        // **图片要一起放进本地列表**，否则发出去后图上就没了
        messages: appendUserMessage(s.messages, text, images),
        thinking: true,
        // **新一轮清空流式缓冲**：上一轮的残留不该跟到这一轮来。
        // 这是"整轮结束"的实际判定点——没有显式的 done 事件，
        // 用"用户又说了一句"作为边界最简单也最准。
        streaming: '',
      }));
      try {
        // 图片单独传：走多模态通道，由运行时按模型能力决定发不发
        await api.say(view.projectId, text, images);
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
    (view && view.kind !== 'global' && view.kind !== 'new'
      ? state.projects.find((p) => p.id === view.projectId)
      : state.projects.find((p) => p.id === state.currentProjectId)) ?? null;

  /**
   * 右栏有没有内容。
   *
   * 没有待决策、也不在项目对话里时，右栏**整块不渲染**——
   * 照 DSH：空的面板不占位，主区自动铺满。
   */
  /**
   * **是不是项目内页面**（Assistant 或 Agent）。
   *
   * 之前右栏和待决策都只判断 `assistant`，于是 Agent 页的右栏
   * 整块不渲染——用户看到的差别就是"Assistant 有分隔线，Agent 没有"。
   * 统一成一个判断，以后加页面类型只改这里。
   */
  const inProject = currentProject !== null &&
    (view?.kind === 'assistant' || view?.kind === 'executor');

  const hasRailContent =
    state.reports.some((r) => r.needsUser && !r.ackedAt) ||
    inProject;

  const currentExecutor: ExecutorDto | null =
    view?.kind === 'executor'
      ? (state.executors.find((e) => e.id === view.executorId) ?? null)
      : null;

  /**
   * 轨迹页要显示**所有 Agent 的工具调用**。
   *
   * 工具轨迹存在各自 Agent 的会话里（source: 'tool' / 'tool-result'），
   * Assistant 会话里只有对话。所以轨迹页必须把这些会话拼起来，
   * 按时间排序后才是完整的执行过程。
   */
  const [agentTrace, setAgentTrace] = useState<readonly MessageDto[]>([]);

  useEffect(() => {
    const projectId = state.currentProjectId;
    if (!projectId) {
      setAgentTrace([]);
      return;
    }
    const agents = state.executors.filter((e) => e.projectId === projectId);
    if (agents.length === 0) {
      setAgentTrace([]);
      return;
    }

    let cancelled = false;
    void Promise.all(
      agents.map((agent) =>
        api
          .executorMessages(agent.id)
          .then((r) => r.messages ?? [])
          .catch(() => [] as MessageDto[]),
      ),
    ).then((results) => {
      if (cancelled) return;
      setAgentTrace(results.flat());
    });

    return () => {
      cancelled = true;
    };
    // 只在项目或 Agent 集合变化时重新拉，不跟每条消息走
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.currentProjectId, state.executors.length]);


  const titleCrumb = currentExecutor
    ? `${currentProject?.name ?? ''} / ${currentExecutor.label}`
    : view?.kind === 'global'
      ? 'Supervisor'
      : (currentProject?.name ?? '未打开项目');

  // 底部状态栏：当前项目所有 Agent 的汇总（照 DSH 的一行指标）。
  const projectStats = (() => {
    if (!currentProject) return undefined;
    const agents = state.executors.filter((e) => e.projectId === currentProject.id);
    let turns = 0;
    let steps = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cached = 0;
    let durationMs = 0;
    let modelMs = 0;
    for (const agent of agents) {
      // metrics 可能还为空（刚建的 Agent 没跑过）
      const m = agent.metrics;
      if (!m) continue;
      turns += m.turns;
      steps += m.steps;
      tokensIn += m.tokensIn;
      tokensOut += m.tokensOut;
      cached += m.cachedTokens ?? 0;
      durationMs += m.durationMs;
      // 只累加等模型的时间：tok/s 要的是"模型多快"，不是"任务整体多快"
      modelMs += m.modelMs ?? 0;
    }

    // 优先用 modelMs；老数据没有就用 durationMs（会偏低，但至少有数）
    const denominator = modelMs > 0 ? modelMs : durationMs;
    const rate = denominator > 0 ? Math.round((tokensOut / denominator) * 1000) : null;
    const total = tokensIn + tokensOut;
    return {
      turns,
      steps,
      tokensPerSecond: rate === null ? '—' : String(rate),
      totalTokens: formatTokens(total),
      cacheHit:
        tokensIn > 0 ? `${Math.round((cached / tokensIn) * 100)}%` : '—',
    };
  })();

  /** executorId → Agent 名字；审批面板靠它标出"是谁要执行"。 */
  const agentLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of state.executors) map.set(e.id, e.label);
    return map;
  }, [state.executors]);

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
      <div
        className="app-shell"
        // 网格列宽必须由这里控制：侧栏内部改 width 时，写死在 CSS 里的
        // 列宽不会跟着变，拖动就会"毫无反应"。
        //
        // **三列**：左栏 / 主区 / 右栏。
        // 右栏宽度也给用户拖（见 rail-resizer），但先固定一个合理值。
        style={{
          gridTemplateColumns: [
            sidebarCollapsed ? '0' : `${sidebarWidth}px`,
            'minmax(0, 1fr)',
            railCollapsed ? '0' : `${railWidth}px`,
          ].join(' '),
        }}
      >
      {/* 折叠时整块隐藏，不只是收窄——收窄到几十像素反而更难看。
          注意：这个包裹层必须是 grid 项目的一部分且**撑满高度**，
          否则侧栏会被内容撑开，"已连接/设置"就贴不到底部去了。 */}
      <div
        className="sidebar-slot"
        style={{ display: sidebarCollapsed ? 'none' : undefined }}
      >
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
        onNewSession={() => setView({ kind: 'new' })}
        onOpenProject={() => setShowOpen(true)}
        onOpenSettings={() => setShowSettings(true)}
        onDeleteExecutor={(projectId, executorId) => void handleDeleteExecutor(projectId, executorId)}
        onRemoveProject={(projectId) => void handleRemoveProject(projectId)}
        onWidthChange={(w) => {
          setSidebarWidth(w);
          saveSidebarWidth(w);
        }}
      />
      </div>

      <main className="main">
        <UpdateBanner api={api} />
        <ApprovalPanel
          approvals={approvals}
          // 多个 Agent 同时请求审批时，靠这个区分"是谁要干"
          agentLabels={agentLabels}
          onApprove={(id, reason) => void handleApprove(id, reason)}
          onReject={(id, reason) => void handleReject(id, reason)}
        />
        {view?.kind === 'global' && (
          <GlobalAssistant
            api={api}
            projects={state.projects}
            onOpenAssistant={(id) => void openAssistant(id)}
            railOpen={!railCollapsed}
            onToggleRail={() => setRailCollapsed((v) => !v)}
          />
        )}

        {/* 新会话：还没选项目。选了才进对应的 Assistant。 */}
        {view?.kind === 'new' && (
          <NewSession
            projects={state.projects}
            onPick={(id) => void openAssistant(id)}
            onCreate={() => setShowOpen(true)}
            railOpen={!railCollapsed}
            onToggleRail={() => setRailCollapsed((v) => !v)}
          />
        )}

        {view?.kind === 'assistant' && currentProject && (
          <>
            {/* 待决策面板已挪到右侧栏（见下面 <RightRail>）。
                它原来在这里，占主区 26% 的垂直空间，
                展开时能把消息区压到 370px。 */}
            <Conversation
            api={api}
            project={currentProject as ProjectDto}
            // 草稿按视图分开：同一项目里对 Assistant 和对 Agent 说的话互不干扰
            draftKey={draftKey({ kind: 'assistant', projectId: currentProject.id })}
            messages={state.messages}
            // 轨迹页要**全部**消息：Assistant 的对话 + 所有 Agent 的工具轨迹
            traceMessages={[...state.messages, ...agentTrace]}
            executors={state.executors.filter((e) => e.projectId === currentProject?.id)}
            onOpenExecutor={(id) => {
              if (currentProject) setView({ kind: 'executor', projectId: currentProject.id, executorId: id });
            }}
            thinking={state.thinking}
            streaming={state.streaming}
            railOpen={!railCollapsed}
            onToggleRail={() => setRailCollapsed((v) => !v)}
            projectPicker={
              <ProjectPicker
                projects={state.projects}
                currentId={currentProject?.id}
                onPick={(id) => void openAssistant(id)}
                onCreate={() => setShowOpen(true)}
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
            stats={projectStats}
            // **图片必须传过去**。
            // 之前是 `onSend={(text) => handleSendToAssistant(text)}`——
            // 只取了第一个参数，images 被静默丢掉。
            // 用户拖图进输入框、点发送，界面上有附件卡，但真正发出去的
            // 只有文字，模型那边完全不知道有图。
            // 这不是"图没显示"，是**图根本没发出去**。
            onSend={(text, images) => void handleSendToAssistant(text, images)}
            onStop={() => void handleStop()}
          />
          </>
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
            onUndo={(effectId) => void handleUndoEffect(effectId, view.projectId)}
            onRollbackAll={() => void handleRollbackAll(view.projectId, view.executorId)}
            railOpen={!railCollapsed}
            onToggleRail={() => setRailCollapsed((v) => !v)}
            api={api}
          />
        )}

        {!view && <div className="empty">正在加载…</div>}
      </main>

      {/* **右侧栏**：待决策、工作区文件、快捷操作。
          用户要求"像 DSH 那样"，把这些从顶部挪到右边——
          顶部面板占的是垂直空间，会直接压扁对话区。 */}
      {/* 收起时整块隐藏：只把宽度设 0 的话，左边框还会留 1px 竖线 */}
        <div className="rail-slot" style={{ display: railCollapsed || !hasRailContent ? 'none' : undefined }}>
      <RightRail
        onClose={() => setRailCollapsed(true)}
        emptyState={
          <RailEmptyState
            onOpenFolder={currentProject ? () => {
              // 在资源管理器里打开项目目录
              void navigator.clipboard?.writeText(currentProject.displayPath);
            } : undefined}
            onOpenSettings={() => setShowSettings(true)}
          />
        }
        decisionCount={
          state.reports.filter((r) => r.needsUser && !r.ackedAt).length
        }
        decisions={
          inProject ? (
            <DecisionPanel
              reports={state.reports}
              onFocusDecision={(id, body) => {
                void handleAcknowledge(id);
                // 问题正文填进输入框，用户接着回答就行（还能改）
                setDraftSeed({ text: `针对「${body.slice(0, 60)}…」\n我的决定是：`, at: Date.now() });
              }}
              onDismiss={(id) => void handleAcknowledge(id)}
            />
          ) : null
        }
      />
      </div>

      {showOpen && (
        <OpenProjectDialog
          onCancel={() => setShowOpen(false)}
          onConfirm={(rootPath, name) => void handleOpenProject(rootPath, name)}
        />
      )}

      {showSettings && settings && (
        // 设置是**独立页面**（照 TRAE / DSH），不是弹窗：
        // 设置项已经多到一个弹窗塞不下，弹窗里滚动很难用，而且挡住主界面。
        <div className="settings-overlay">
          <SettingsPage
            api={api}
            status={settings}
            projects={state.projects}
            iconTheme={iconTheme}
            onPickIconTheme={pickIconTheme}
            onClose={() => setShowSettings(false)}
            onSaved={setSettings}
          />
        </div>
      )}

      {showPalette && (
        <CommandPalette
          items={paletteItems}
          onClose={() => setShowPalette(false)}
          onSearch={async (q) => {
            // 全文搜索会话内容：找到后跳到那个会话
            const { hits } = await api.search(q);
            return hits.slice(0, 8).map((hit) => ({
              id: `hit-${hit.messageId}`,
              label: hit.snippet,
              hint: `${hit.projectName} · ${hit.sessionLabel}`,
              group: '会话内容',
              run: () => {
                // **直接跳到那条消息所在的会话**。
                // 只跳到项目的话，用户还得自己在会话列表里找一遍。
                if (hit.executorId) void openExecutor(hit.projectId, hit.executorId);
                else void openAssistant(hit.projectId);
              },
            }));
          }}
        />
      )}

      {/* 成功操作的轻量提示：绿色、自动消失，**不是**错误卡片 */}
      {notice && (
        <div className="notice-card" role="status">
          <span className="notice-card-text">{notice}</span>
          <button
            type="button"
            className="notice-card-close"
            onClick={() => setNotice(null)}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      )}

      {errorInfo && (
        // 错误是**事实**，不是提示——不自动消失，用户自己关。
        // 分类展示：告诉用户"谁该动这一步"，而不只是甩一行红字。
        <div className={`error-card tone-${errorInfo.tone}`} role="alert">
          <div className="error-card-head">
            <span className="error-card-kind">{ERROR_KIND_LABEL[errorInfo.kind]}</span>
            <span className="error-card-title">{errorInfo.title}</span>
            <button
              type="button"
              className="error-card-close"
              onClick={() => setError(null)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <p className="error-card-action">{errorInfo.action}</p>
          <details className="error-card-detail">
            <summary>原始信息</summary>
            <pre>{errorInfo.detail}</pre>
          </details>
        </div>
      )}
      </div>
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
      <h1>OpenCoxswain</h1>
      <p className="muted onboarding-sub">舵手</p>
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

      <button type="button" className="btn btn--primary btn--md wide" onClick={() => void submit()} disabled={busy}>
        {busy ? '保存中…' : '开始使用'}
      </button>
    </div>
  );
}
