/**
 * LLM 会话循环（Agent 的核心）。
 *
 * 这是自研运行时的地基：一个 Agent 就是「system prompt + 消息历史 + 可用工具」，
 * 循环地让模型决定下一步——要么调工具，要么给出最终答复。
 *
 * 刻意做成**与具体角色无关**的通用抽象：
 * - C（Assistant）和 D（Agent）用同一个循环，只是 prompt 与工具集不同；
 * - 工具执行由调用方注入（`ToolHost`），循环本身不碰文件系统；
 * - 中途输入通过 `inbox` 注入，**不打断当前轮**（见 inbox/queue.ts）。
 *
 * 这一段是从 legacy `packages/adapters/src/builtin.ts` 的 `drive()` 提炼出来的，
 * 保留了它的正确行为（工具结果回填、JSON 解析失败要回灌给模型、中止检查），
 * 但把"任务契约 / worktree / 验收"这些上层概念剥了出去。
 */
import type {
  AgentMessage,
  ChatMessage,
  LlmClient,
  LlmToolCall,
  ToolDefinition,
} from '../llm/types.js';
import { compactMessages, type CompactOptions } from './compact.js';

/** 工具执行宿主：由角色层提供，循环只负责调度。 */
export interface ToolHost {
  /** 当前可用的工具定义（每轮重取，便于动态变化）。 */
  definitions(): readonly ToolDefinition[];
  /** 执行一次工具调用。抛错会被转成工具错误回灌给模型，而不是中断整个循环。 */
  execute(call: { readonly name: string; readonly args: Record<string, unknown> }): Promise<{
    readonly ok: boolean;
    readonly content: string;
  }>;
}

/** 循环产生的事件。上层据此落库、推送 UI、触发汇报。 */
export type LoopEvent =
  | { readonly type: 'steering'; readonly text: string }
  | { readonly type: 'assistant_text'; readonly text: string; readonly final: boolean }
  | { readonly type: 'tool_call'; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly type: 'tool_result'; readonly name: string; readonly ok: boolean; readonly preview: string }
  | {
      readonly type: 'usage';
      readonly tokensIn: number;
      readonly tokensOut: number;
      /** 缓存命中的输入 token；模型未报告时为 undefined（不是 0）。 */
      readonly cachedTokens?: number;
      /**
       * **这一轮模型调用本身花了多少毫秒**。
       *
       * 为什么单独记：`tok/s` 应该是"模型输出速度"，
       * 而整个任务的墙钟时间里有一大半是在跑工具、等审批。
       * 用任务总时长算出的是"整体吞吐"，不是模型速度——
       * 那个数字看起来像"模型很快"，实际包含了工具耗时，是误导。
       */
      readonly modelMs?: number;
    }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean }
  | {
      /** 上下文被压缩过（工具结果剪枝 / 历史折叠）。 */
      readonly type: 'compacted';
      readonly prunedToolResults: number;
      readonly droppedMessages: number;
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    }
  | { readonly type: 'done'; readonly finalText: string; readonly steps: number };

export interface RunLoopOptions {
  readonly llm: LlmClient;
  readonly toolHost: ToolHost;
  /** 会话历史（会被追加，调用方持有）。第一项通常是 system。 */
  readonly messages: ChatMessage[];
  /** 单轮最多几次模型往返，防止死循环。 */
  readonly maxSteps: number;
  /** 上下文压缩参数；不提供时用默认值。 */
  readonly compact?: CompactOptions;
  /** 中止信号：用户点停止、或 shutdown。 */
  readonly signal: AbortSignal;
  /**
   * 取走排队中的中途输入。每步开头调用一次。
   * 返回的文本会作为 user 消息追加到历史——**不打断**当前这一步。
   */
  readonly drainInputs?: () => readonly string[];
  /** 工具输出回灌给模型时的截断长度。 */
  readonly maxToolOutputChars?: number;
}

const DEFAULT_MAX_TOOL_OUTPUT = 4000;

/**
 * 跑一轮完整的 Agent 循环。
 *
 * 终止条件：
 * - 模型不再调用工具（给出最终答复）→ 正常结束
 * - 达到 `maxSteps` → 以最后一次文本结束，并留下 error 事件说明
 * - 被中止 → 立即返回
 */
export async function* runLoop(options: RunLoopOptions): AsyncGenerator<LoopEvent, void, void> {
  const { llm, toolHost, messages, maxSteps, signal } = options;
  const maxToolOutput = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT;
  const compactOptions = options.compact ?? {};
  let lastText = '';
  let step = 0;

  for (; step < maxSteps; step += 1) {
    if (signal.aborted) return;

    // 中途输入：排在当前步之前注入，等价于"看到新要求再决定下一步"。
    const inputs = options.drainInputs?.() ?? [];
    for (const text of inputs) {
      messages.push({ role: 'user', content: text });
      yield { type: 'steering', text };
    }

    // **上下文压缩**：每次调用模型前检查历史是否接近上限。
    //
    // 不压缩的话，跑几十步就会超模型上下文窗口然后整轮失败——
    // 用户看到的是"跑到一半突然报错"。
    //
    // 顺序是"先剪枝（便宜、无损语义）再折叠"，见 compact.ts 的说明。
    if (messages.length > 0) {
      const compacted = compactMessages(messages, compactOptions);
      if (compacted.changed) {
        messages.length = 0;
        messages.push(...compacted.messages);
        yield {
          type: 'compacted',
          prunedToolResults: compacted.prunedToolResults,
          droppedMessages: compacted.droppedMessages,
          tokensBefore: compacted.tokensBefore,
          tokensAfter: compacted.tokensAfter,
        };
      }
    }

    let response;
    // 只计模型调用本身的时间——不含工具执行、不含排队。
    // tok/s 要反映"模型多快"，不是"这个任务整体多快"。
    const modelStartedAt = Date.now();
    try {
      response = await llm.chat({
        messages,
        tools: [...toolHost.definitions()],
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      const message = errorText(error);
      // 4xx 是配置/参数问题，重试没有意义。
      const retryable = !/HTTP 4\d\d|\b401\b|\b403\b/.test(message);
      yield { type: 'error', message: `调用模型失败：${message}`, retryable };
      return;
    }
    const modelMs = Date.now() - modelStartedAt;

    if (response.tokensIn || response.tokensOut) {
      yield {
        type: 'usage',
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        ...(response.cachedTokens !== undefined ? { cachedTokens: response.cachedTokens } : {}),
        modelMs,
      };
    }

    const calls: readonly LlmToolCall[] = response.toolCalls ?? [];
    const text = (response.text ?? '').trim();

    if (calls.length === 0) {
      if (text) {
        lastText = text;
        yield { type: 'assistant_text', text, final: true };
      }
      yield { type: 'done', finalText: lastText, steps: step + 1 };
      return;
    }

    // 有工具调用：先把 assistant 的这段（含 tool_calls）写进历史。
    messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    });
    if (text) {
      lastText = text;
      // 调工具前的说明文字不算最终答复，但要展示出来。
      yield { type: 'assistant_text', text, final: false };
    }

    for (const call of calls) {
      if (signal.aborted) return;
      const args = call.args ?? {};
      yield { type: 'tool_call', name: call.name, args };

      let result: { ok: boolean; content: string };
      try {
        result = await toolHost.execute({ name: call.name, args });
      } catch (error) {
        // 工具抛错不是致命错误：把错误回灌给模型，让它自己决定怎么办。
        // 这正是"卡住时主动推进"的物理基础。
        result = { ok: false, content: `工具执行失败：${errorText(error)}` };
      }

      yield {
        type: 'tool_result',
        name: call.name,
        ok: result.ok,
        preview: result.content.slice(0, 300),
      };

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncate(result.content, maxToolOutput),
      });
    }
  }

  // 步数用尽：如实报告，不假装完成。
  yield {
    type: 'error',
    message: `达到单轮最大步数 ${maxSteps}，本轮以未完成状态结束。`,
    retryable: true,
  };
  yield { type: 'done', finalText: lastText, steps: maxSteps };
}

/** 不带工具跑一次纯对话（Supervisor 的路由判断、记忆提炼等场景）。 */
export async function chatOnce(
  llm: LlmClient,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const response = await llm.chat({ messages, tools: [], signal });
  return (response.text ?? '').trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断 ${text.length - max} 字）`;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `[${code}] ${error.message}` : error.message;
  }
  return String(error);
}

/** 把一段 Agent 消息历史转成 LLM 需要的形态。 */
export function toChatMessages(messages: readonly AgentMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
}
