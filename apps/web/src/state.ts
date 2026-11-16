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
  /**
   * 流式过程中的**临时**文字。
   *
   * 模型边生成边推 `assistant_delta`，这里累加。收到 `assistant_text`
   * （定稿）时清空——真正的消息由 messages 承载。
   *
   * **不落库**：它是过程，刷新就没了，这是对的。
   */
  readonly streaming: string;
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
  streaming: '',
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
    case 'assistant_delta': {
      if (event.projectId !== state.currentProjectId) return next;
      // **累加**：每个 delta 是一小段，拼起来才是完整回复。
      //
      // thinking 立刻置 false：文字已经在长了，不该再显示"思考中"。
      return { ...next, thinking: false, streaming: next.streaming + event.text };
    }
    case 'assistant_text': {
      if (event.projectId !== state.currentProjectId) return next;
      // ## 定稿和缓冲的关系（2026-11-16 实测踩了两轮才理清）
      //
      // `assistant_text` 是**每一步**都发（包括调工具前那一步），
      // 不是"整轮结束"。所以不能简单地把它当"清空信号"——
      // 那样一行字刚流出来就被清掉，表现为"闪一下然后消失"。
      //
      // 正确的关系：
      //   - 定稿的文本已经进 `messages`，由消息列表渲染
      //   - `streaming` 缓冲里**重复的那部分要扣掉**，否则同一段字显示两遍
      //
      // 扣法：定稿是缓冲的前缀 → 扣掉；内容相同 → 清空；对不上 → 清空
      // （对不上说明是新的一步，缓冲肯定是旧的）。
      const settled = event.text;
      let remaining: string;
      if (!next.streaming) {
        remaining = '';
      } else if (next.streaming === settled) {
        remaining = '';
      } else if (settled && next.streaming.startsWith(settled)) {
        remaining = next.streaming.slice(settled.length);
      } else {
        // 定稿不是缓冲的前缀：这一步的缓冲已经没用了（进 messages 了）。
        remaining = '';
      }
      return {
        ...next,
        thinking: false,
        streaming: remaining,
        // **按 final 决定合并方式**（2026-11-16 用户截图：同一段显示两遍）。
        //
        // 用户看到的是：
        //
        //   Assistant
        //     结论：已派出只读 Agent 统计 docs…
        //     做了什么：派出一个 writeScope 为 readonly 的 Agent…
        //
        //   Assistant                    ← 又一遍
        //     我先派一个只读 Agent 去统计。结论：已派出只读 Agent…
        //     做了什么：派出一个 writeScope 为 readonly 的 Agent…
        //
        // 原因：`final: true` 的真答复**会把调工具前的说明一起重说一遍**，
        // 而前端无脑追加，就拼成了两遍。
        //
        // 现在：
        //   - final=false（调工具前的说明）→ 追加，是过程的补充
        //   - final=true （这一步讲完了）  → **替换**本步的临时内容
        messages: mergeAssistantText(
          next.messages,
          event.text,
          event.final !== false ? 'replace' : 'append',
        ),
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
 * 合并一段助手文本。
 *
 * `mode`：
 * - `append`：调工具前的说明，拼到本步已有内容后面
 * - `replace`：这一步讲完了的真答复，**替换**本步内容
 *
 * ## 为什么需要 replace（2026-11-16 用户截图）
 *
 * 用户看到同一段显示两遍：
 *
 *     Assistant
 *       结论：已派出只读 Agent 统计 docs…
 *       做了什么：派出一个 writeScope 为 readonly 的 Agent…
 *
 *     Assistant
 *       我先派一个只读 Agent 去统计。结论：已派出只读 Agent…
 *       做了什么：派出一个 writeScope 为 readonly 的 Agent…
 *
 * 因为模型的真答复（final=true）**会把调工具前那段说明一起重说一遍**。
 * 无脑追加就拼成了两遍，还错位。
 */
export function mergeAssistantText(
  messages: readonly MessageDto[],
  text: string,
  mode: 'append' | 'replace' = 'append',
): MessageDto[] {
  const last = messages.at(-1);
  if (last && last.role === 'assistant' && last.source === 'assistant-stream') {
    // **replace 只在"同一步内"生效**。
    //
    // `assistant-stream` 标记会一直留在最后一条上。如果用户过十分钟又问一句，
    // 那条还是没有落库的临时消息——此时 replace 会把**上一轮的真答复**覆盖掉。
    //
    // 所以加时间窗：超过 2 分钟就不认为是"这一步"了，改成新建一条。
    const fresh = Date.now() - last.at < 2 * 60_000;
    if (!fresh) {
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
    const merged: MessageDto = {
      ...last,
      // replace 时用新文本覆盖本步内容——模型已经把话讲全了。
      content: mode === 'replace' ? text : `${last.content}\n\n${text}`.trim(),
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
/**
 * 把用户刚发的一条消息放进列表（乐观显示）。
 *
 * **必须带 images**：不带的话，发图片时本地列表里那张图会消失，
 * 看起来像是发送失败——实际后端收到了，只是界面没显示。
 * 实测踩过：用户附了图、发出去、图没了，以为没发出去。
 */
export function appendUserMessage(
  messages: readonly MessageDto[],
  text: string,
  images?: ReadonlyArray<{ type: 'image'; dataUrl: string; name?: string }>,
): MessageDto[] {
  return [
    ...messages,
    {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      role: 'user',
      content: text,
      source: 'webapp',
      at: Date.now(),
      ...(images && images.length > 0 ? { images } : {}),
    },
  ];
}

/** 保留在跑的与最近的已结束Agent。 */
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
  // **交回**是独立状态，不能说成"未完成"。
  // Agent 是干对了的——它发现了问题在别处，这跟出错是两回事。
  handback: '已交回',
};
