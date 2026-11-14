/**
 * Agent运行器：把一个 Agent 从"已排到队"跑到"有了结论"。
 *
 * 从 `orchestrator.ts` 整块搬出来（原来那个方法 300 多行，
 * 和派活、排队、汇报混在一起，改任何一处都要读完整个文件）。
 *
 * 这个模块**只管运行**：
 * - 不决定"派不派"（那是 spawn 的事）
 * - 不决定"怎么告诉用户"（那是汇报的事）
 */
import type { LlmClient } from '../llm/types.js';
import type { SearchConfig } from './web.js';
import type { LoopEvent } from '../session/loop.js';
import type { SkillSummary } from '../skills/index.js';
import type { SnapshotStore } from '../security/snapshot.js';
import type { McpTool } from '../mcp/client.js';
import {
  isExecutorTerminal,
  newId,
  type ExecutorRow,
  type ProjectRow,
  type Store,
} from '../store/store.js';
import {
  runExecutor,
  executorSystemPrompt,
  type ExecutorOutcome,
} from '../executor/executor.js';
import { SideEffectLedger } from '../security/ledger.js';
import type { ExecutorToolHostOptions } from '../executor/executor.js';

/** 把工具参数压成一行，避免一条命令把会话刷屏。 */
export function truncateArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  if (!text) return '';
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
}

/** 运行器需要外部提供的能力；由 Orchestrator 注入。 */
export interface ExecutorRunnerDeps {
  readonly store: Store;
  readonly llm: LlmClient;
  /**
   * 联网搜索配置。不传时 `web_search` 会明确告诉模型"不可用"。
   */
  readonly search?: SearchConfig | null;
  readonly maxSteps: number;
  readonly commandTimeoutMs?: number;
  /**
   * 这个项目可用的技能（只含名称与描述）。
   *
   * 系统提示里只渲染这些名称和描述，正文要模型调 `use_skill` 才加载——
   * 这是省上下文的关键：一个 2000 字的技能平时只占约 20 token。
   */
  readonly skills?: readonly SkillSummary[];
  /** 文件快照（撤销用）。不提供就不备份。 */
  readonly snapshots?: SnapshotStore;
  /** MCP 工具（名字带服务器前缀）。 */
  readonly mcpTools?: readonly McpTool[];
  /** MCP 调用入口。 */
  readonly mcp?: {
    call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
  };
  /** 危险动作审批。 */
  readonly approve: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
  /** 取并清空该Agent待注入的消息（连发不打断）。 */
  readonly drainInputs: (executorId: string) => readonly string[];
  /** 每轮用量回调（供止损判定）。 */
  readonly onProgressMetrics: (
    executorId: string,
    partial: { tokensIn: number; tokensOut: number },
  ) => void;
  /**
   * 每轮结束时回调当前进展文本。
   *
   * **被中断时靠它保住"已经做到哪了"**。
   * 不记的话，用户按停止之后，这个 Agent 在 Assistant 眼里等于什么都没做——
   * 它跑了几十步、读了哪些文件、得出了什么初步结论，全都没有浮出来。
   */
  readonly onPartialText?: (executorId: string, text: string) => void;
  /** 用户扩展（geek 自定义口）。 */
  readonly extensions?: ExecutorToolHostOptions['extensions'];
}

export interface RunResult {
  readonly outcome: ExecutorOutcome | undefined;
  readonly error: string | undefined;
}

/**
 * 真正把 D 跑起来。
 *
 * 调用前必须已经拿到闸门（写域互斥/并发位），调用后由调用方负责释放。
 */
export async function runExecutorOnce(
  deps: ExecutorRunnerDeps,
  project: ProjectRow,
  executor: ExecutorRow,
  controller: AbortController,
): Promise<RunResult> {
  const { store } = deps;

  // 建 Agent 的会话行（历史可回看 = "打开原会话"）。
  // systemPrompt 存下来，续聊时才能重建同样的角色设定。
  await store.putSession({
    id: executor.sessionId,
    kind: 'executor',
    projectId: project.id,
    parentSessionId: project.assistantSessionId,
    label: executor.label,
    systemPrompt: executorSystemPrompt({
      projectName: project.name,
      goal: executor.goal,
      writeScope: executor.writeScope,
      ...(executor.access === 'readonly' ? { readonlyTask: true } : {}),
      skills: deps.skills ?? [],
      ...(deps.mcpTools ? { mcpTools: deps.mcpTools } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
    }),
    status: 'running',
    resumable: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // 首轮目标作为 Agent 会话的第一条用户消息落库（轨迹从这里开始）。
  await store.appendMessage(executor.sessionId, {
    id: newId('msg'),
    role: 'user',
    content: executor.goal,
    source: 'assistant',
    at: Date.now(),
  });
  await store.putExecutor({ ...executor, status: 'running' });

  try {
    const outcome = await runExecutor({
      llm: deps.llm,
      ...(deps.search ? { search: deps.search } : {}),
      // 用原始大小写路径作为工作目录（归一化路径仅用于判重）。
      rootPath: project.displayPath,
      projectName: project.name,
      goal: executor.goal,
      writeScope: executor.writeScope,
      ...(executor.access === 'readonly' ? { readonlyTask: true } : {}),
      signal: controller.signal,
      maxSteps: deps.maxSteps,
      // 危险动作审批：不可逆的动作执行前必须有人拍板。
      approve: (tool, args) => deps.approve(tool, args),
      // 技能：模型调 use_skill 时据此加载正文。
      skills: deps.skills ?? [],
      ...(deps.mcpTools ? { mcpTools: deps.mcpTools } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      // 用户扩展（geek 自定义口）：可用于否决与观察。
      ...(deps.extensions ? { extensions: deps.extensions } : {}),
      // 副作用台账：执行前落 pending，执行后结算。
      ledger: new SideEffectLedger({
        store,
        projectId: project.id,
        executorId: executor.id,
      }),
      // 快照：runExecutor 内部会自己建 tool host，必须在这一层传进去
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
      // 文件快照：写文件前留一份原内容，用于事后撤销。
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
      ...(deps.commandTimeoutMs !== undefined ? { commandTimeoutMs: deps.commandTimeoutMs } : {}),
      drainInputs: () => deps.drainInputs(executor.id),
      // 轨迹落库：每一步工具调用都记下来，供"打开原会话"查看。
      onEvent: traceHandler(store, executor.sessionId, (text) =>
        deps.onPartialText?.(executor.id, text),
      ),
      // 用量止损：每轮用量累积后检查，超线立即中止（不是等账单出来）。
      onProgressMetrics: (partial) => deps.onProgressMetrics(executor.id, partial),
      onMetrics: (metrics) => {
        const current = store.getExecutor(executor.id);
        if (current) void store.putExecutor({ ...current, metrics });
      },
    });

    return { outcome, error: undefined };
  } catch (error) {
    return {
      outcome: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 排队期间可能已被取消：返回 null 表示不该再跑。 */
export function stillRunnable(store: Store, executorId: string): ExecutorRow | null {
  const current = store.getExecutor(executorId);
  if (!current || isExecutorTerminal(current.status)) return null;
  return current;
}

/**
 * 把工具轨迹写进 Agent 的会话。
 *
 * 首轮和续聊共用——之前两处各写了一份一模一样的代码，
 * 改一处容易漏另一处。
 */
export function traceHandler(
  store: Store,
  sessionId: string,
  /** 每轮文本回调：用于在中断时保住进展。 */
  onPartial?: (text: string) => void,
): (event: LoopEvent) => void {
  return (event) => {
    // **上下文压缩**：记一条轨迹，让用户知道历史被压缩过。
    // 不记的话，用户只会觉得"模型怎么忘了前面说过什么"。
    if (event.type === 'compacted') {
      const summary =
        event.droppedMessages > 0
          ? `上下文已压缩：折叠 ${event.droppedMessages} 条历史` +
            (event.prunedToolResults > 0 ? `、剪枝 ${event.prunedToolResults} 条工具输出` : '') +
            `（约 ${event.tokensBefore} → ${event.tokensAfter} token）`
          : `上下文已压缩：剪枝 ${event.prunedToolResults} 条超长工具输出` +
            `（约 ${event.tokensBefore} → ${event.tokensAfter} token）`;
      void store.appendMessage(sessionId, {
        id: newId('msg'),
        role: 'assistant',
        content: summary,
        source: 'compaction',
        at: Date.now(),
      });
      return;
    }
    if (event.type === 'tool_call') {
      void store.appendMessage(sessionId, {
        id: newId('msg'),
        role: 'user',
        content: `\u0060${event.name}\u0060 ${truncateArgs((event.args ?? {}) as Record<string, unknown>)}`,
        source: 'tool',
        at: Date.now(),
      });
    } else if (event.type === 'tool_result') {
      void store.appendMessage(sessionId, {
        id: newId('msg'),
        role: 'assistant',
        content: event.ok ? (event.preview ?? '') : `（失败）${event.preview ?? ''}`,
        source: 'tool-result',
        at: Date.now(),
      });
    } else if (event.type === 'assistant_text' && event.text.trim()) {
      // **每轮文本都往上报一次进展**。
      //
      // 用法：agent 跑到一半被用户停止时，上层能说出"它停之前做到哪了"。
      // 不报的话，这个 Agent 在 Assistant 眼里等于什么都没做。
      onPartial?.(event.text);
    }
  };
}

/**
 * 续聊：带着原有上下文继续跑同一个 D。
 *
 * 和首轮的区别只有三处：
 * - 不重建会话（会话已存在）
 * - 传入 `priorMessages` 作为上下文
 * - `goal` 是这一次的追问，不是最初的派活目标
 *
 * 其余（审批、台账、扩展、轨迹记录）完全一致——**这正是要抽出来的理由**：
 * 之前复制了一份，结果续聊漏了台账，两处行为悄悄不一致了。
 */
export interface ResumeRequest {
  readonly executor: ExecutorRow;
  readonly project: ProjectRow;
  /** 用户这一轮说的话。 */
  readonly text: string;
  readonly priorMessages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
  readonly controller: AbortController;
}

export async function resumeExecutorOnce(
  deps: ExecutorRunnerDeps,
  request: ResumeRequest,
): Promise<RunResult> {
  const { store } = deps;
  const { executor, project } = request;

  await store.putExecutor({
    ...executor,
    status: 'running',
    endedAt: null,
    blockedReason: null,
  });

  try {
    const outcome = await runExecutor({
      llm: deps.llm,
      ...(deps.search ? { search: deps.search } : {}),
      rootPath: project.displayPath,
      projectName: project.name,
      goal: request.text,
      writeScope: executor.writeScope,
      ...(executor.access === 'readonly' ? { readonlyTask: true } : {}),
      signal: request.controller.signal,
      maxSteps: deps.maxSteps,
      // 续聊同样受审批约束：不能借续聊绕过危险动作检查。
      approve: (tool, args) => deps.approve(tool, args),
      // 续聊同样受扩展约束：不能借续聊绕过本机策略。
      ...(deps.extensions ? { extensions: deps.extensions } : {}),
      // 续聊同样记账：不能借续聊留下无记录的副作用。
      ledger: new SideEffectLedger({
        store,
        projectId: project.id,
        executorId: executor.id,
      }),
      // 快照：runExecutor 内部会自己建 tool host，必须在这一层传进去
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
      // 文件快照：写文件前留一份原内容，用于事后撤销。
      ...(deps.snapshots ? { snapshots: deps.snapshots } : {}),
      ...(deps.commandTimeoutMs !== undefined ? { commandTimeoutMs: deps.commandTimeoutMs } : {}),
      priorMessages: request.priorMessages as never,
      onEvent: traceHandler(store, executor.sessionId, (text) =>
        deps.onPartialText?.(executor.id, text),
      ),
      onProgressMetrics: (partial) => deps.onProgressMetrics(executor.id, partial),
      onMetrics: (metrics) => {
        const current = store.getExecutor(executor.id);
        if (current) void store.putExecutor({ ...current, metrics });
      },
    });

    return { outcome, error: undefined };
  } catch (error) {
    return {
      outcome: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 从会话历史里取上下文（排除最后一条，它作为本轮的 goal）。 */
export function priorMessagesFrom(
  store: Store,
  sessionId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return store
    .messages(sessionId)
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      // 工具轨迹是给界面看的，回灌模型时加上标记，避免被当成用户发言。
      content:
        m.source === 'tool' || m.source === 'tool-result'
          ? `（执行记录）${m.content}`
          : m.content,
    }));
}
