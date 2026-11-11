/**
 * 执行者运行器：把一个 D 从"已排到队"跑到"有了结论"。
 *
 * 从 `orchestrator.ts` 整块搬出来（原来那个方法 300 多行，
 * 和派活、排队、汇报混在一起，改任何一处都要读完整个文件）。
 *
 * 这个模块**只管运行**：
 * - 不决定"派不派"（那是 spawn 的事）
 * - 不决定"怎么告诉用户"（那是汇报的事）
 */
import type { LlmClient } from '../llm/types.js';
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
  readonly maxSteps: number;
  readonly commandTimeoutMs?: number;
  /** 危险动作审批。 */
  readonly approve: (
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<{ approved: boolean; reason: string }>;
  /** 取并清空该执行者待注入的消息（连发不打断）。 */
  readonly drainInputs: (executorId: string) => readonly string[];
  /** 每轮用量回调（供止损判定）。 */
  readonly onProgressMetrics: (
    executorId: string,
    partial: { tokensIn: number; tokensOut: number },
  ) => void;
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

  // 建 D 的会话行（历史可回看 = "打开原会话"）。
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
    }),
    status: 'running',
    resumable: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // 首轮目标作为 D 会话的第一条用户消息落库（轨迹从这里开始）。
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
      // 用户扩展（geek 自定义口）：可用于否决与观察。
      ...(deps.extensions ? { extensions: deps.extensions } : {}),
      // 副作用台账：执行前落 pending，执行后结算。
      ledger: new SideEffectLedger({
        store,
        projectId: project.id,
        executorId: executor.id,
      }),
      ...(deps.commandTimeoutMs !== undefined ? { commandTimeoutMs: deps.commandTimeoutMs } : {}),
      drainInputs: () => deps.drainInputs(executor.id),
      // 轨迹落库：每一步工具调用都记下来，供"打开原会话"查看。
      onEvent: (event) => {
        if (event.type === 'tool_call') {
          void store.appendMessage(executor.sessionId, {
            id: newId('msg'),
            role: 'user',
            content: `\u0060${event.name}\u0060 ${truncateArgs(event.args)}`,
            source: 'tool',
            at: Date.now(),
          });
        } else if (event.type === 'tool_result') {
          void store.appendMessage(executor.sessionId, {
            id: newId('msg'),
            role: 'assistant',
            content: event.ok ? event.preview : `（失败）${event.preview}`,
            source: 'tool-result',
            at: Date.now(),
          });
        }
      },
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
