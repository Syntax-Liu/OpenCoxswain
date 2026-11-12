/**
 * 界面状态：快照 + 增量的合并逻辑。
 *
 * 刻意做成**纯函数**，便于单测——界面状态合并是最容易出"消息重复/丢失"
 * 的地方，把它从 React 里剥出来才能验证。
 *
 * 三条规则：
 * 1. 快照是权威：重拉快照时整体替换。
 * 2. 增量按 seq 去重：同一事件重复到达（重连补发）不能重复应用。
 * 3. 助手回复按"内容 + 时间邻近"合并：C 一次回复可能分多个 assistant_text
 *    事件（先一句说明，再一段结论），界面应当看起来是一条消息。
 */
import type { ExecutorDto, MessageDto, ProjectDto, ReportDto, RuntimeEventDto } from './api.js';

export interface AppState {
  readonly projects: readonly ProjectDto[];
  readonly currentProjectId: string | null;
  readonly messages: readonly MessageDto[];
  readonly executors: readonly ExecutorDto[];
  readonly reports: readonly ReportDto[];
  readonly connected: boolean;
  readonly connectionDetail: string | null;
  /** 已应用的最大 seq，用于去重。 */
  readonly appliedSeq: number;
  /** 顶部的错误提示（可关闭）。 */
  readonly error: string | null;
  /** 正在等待 C 回复（发出消息后置 true，收到 assistant_text 后 false）。 */
  readonly thinking: boolean;
}

export const initialState: AppState = {
  projects: [],
  currentProjectId: null,
  messages: [],
  executors: [],
  reports: [],
  connected: false,
  connectionDetail: null,
  appliedSeq: 0,
  error: null,
  thinking: false,
};

/** 合并一次快照。 */
export function applySnapshot(
  state: AppState,
  snapshot: {
    projects?: readonly ProjectDto[];
    messages?: readonly MessageDto[];
    executors?: readonly ExecutorDto[];
    reports?: readonly ReportDto[];
    lastSeq?: number;
  },
): AppState {
  return {
    ...state,
    projects: snapshot.projects ?? state.projects,
    messages: snapshot.messages ?? state.messages,
    executors: snapshot.executors ?? state.executors,
    reports: snapshot.reports ?? state.reports,
    appliedSeq: snapshot.lastSeq ?? state.appliedSeq,
  };
}

/** 合并一条增量事件。重复 seq 直接忽略（幂等）。 */
export function applyEvent(state: AppState, seq: number, event: RuntimeEventDto): AppState {
  if (seq > 0 && seq <= state.appliedSeq) {
    // 已经应用过：重连补发导致的重复，忽略即可。
    return state;
  }
  const next = { ...state, appliedSeq: Math.max(state.appliedSeq, seq) };

  switch (event.type) {
    case 'assistant_text': {
      if (event.projectId !== state.currentProjectId) return next;
      return {
        ...next,
        thinking: false,
        messages: mergeAssistantText(next.messages, event.text),
        // 项目列表里的"待决策"数字可能变了，等下一次快照刷新；这里不动。
      };
    }
    case 'executor_started':
    case 'executor_queued': {
      if (event.projectId !== state.currentProjectId) return next;
      return {
        ...next,
        executors: upsertExecutor(next.executors, event.executor),
        thinking: false,
      };
    }
    case 'executor_settled': {
      if (event.projectId !== state.currentProjectId) return next;
      return {
        ...next,
        executors: upsertExecutor(next.executors, event.executor),
      };
    }
    case 'report': {
      if (event.projectId !== state.currentProjectId) return next;
      if (next.reports.some((r) => r.id === event.report.id)) return next;
      return { ...next, reports: [...next.reports, event.report] };
    }
    case 'turn_judged': {
      // 冲突判定目前只用于诊断展示，不改主状态。
      return next;
    }
    case 'gap': {
      return next;
    }
    default:
      return next;
  }
}

export function upsertExecutor(
  executors: readonly ExecutorDto[],
  executor: ExecutorDto,
): ExecutorDto[] {
  const index = executors.findIndex((e) => e.id === executor.id);
  if (index < 0) return [...executors, executor];
  const copy = [...executors];
  copy[index] = executor;
  return copy;
}

/**
 * 追加一段助手文本。
 *
 * 合并规则：如果上一条是"同一轮刚产生的助手消息"（保留源标记），
 * 就拼到它后面；否则新建一条。这样 Assistant 的"收到，我派 X 去做"和随后的
 * 结论不会变成两条割裂的消息。
 */
export function mergeAssistantText(
  messages: readonly MessageDto[],
  text: string,
): MessageDto[] {
  const last = messages.at(-1);
  if (last && last.role === 'assistant' && last.source === 'assistant-stream') {
    const merged: MessageDto = {
      ...last,
      content: `${last.content}\n\n${text}`.trim(),
      at: Date.now(),
    };
    return [...messages.slice(0, -1), merged];
  }
  return [
    ...messages,
    {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'assistant',
      content: text,
      source: 'assistant-stream',
      at: Date.now(),
    },
  ];
}

/** 用户发出消息后立刻显示（乐观更新）。 */
export function appendUserMessage(messages: readonly MessageDto[], text: string): MessageDto[] {
  return [
    ...messages,
    {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content: text,
      source: 'webapp',
      at: Date.now(),
    },
  ];
}

/** 保留在跑的与最近的已结束执行者。 */
export function visibleExecutors(executors: readonly ExecutorDto[], keepFinished = 8): ExecutorDto[] {
  const running = executors.filter((e) => e.status === 'starting' || e.status === 'running');
  const finished = executors
    .filter((e) => !(e.status === 'starting' || e.status === 'running'))
    .slice(-keepFinished);
  return [...finished, ...running].sort((a, b) => a.createdAt - b.createdAt);
}

export const EXECUTOR_STATUS_LABEL: Record<ExecutorDto['status'], string> = {
  starting: '启动中',
  running: '执行中',
  done: '已完成',
  failed: '未完成',
  cancelled: '已取消',
};
