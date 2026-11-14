/**
 * 子 Agent（Subagent）：Agent 在执行当前任务的过程中，临时拆出一个子任务。
 *
 * ## 和 `spawn_executor` 的本质区别
 *
 * ```
 * Assistant → Agent（spawn_executor）
 *   同级委派。派出去的是**另一个会话**，有自己的侧栏条目、状态、台账。
 *   Assistant 不等待结果，可以并行派多个，之后汇总。
 *
 * Agent → Subagent（spawn_subagent）
 *   嵌套执行。为了完成**当前这个任务**而临时拆出的子任务。
 *   **同步等结果**，结果直接回到父 Agent 的上下文里。
 *   不建会话、不进侧栏、用户看不到中间过程。
 * ```
 *
 * 前者是"分工协作"，后者是"这件事我先分头查清楚再继续"。
 * 所以 Subagent 不落库、不排队、不需要写域互斥——它是父 Agent 的一次
 * 内部函数调用。
 *
 * ## 硬约束
 *
 * 1. **同步**：父 Agent 等到结果才继续（这是它的价值：结果进上下文）
 * 2. **不建会话**：没有 executor 行，不进侧栏，不打扰用户
 * 3. **深度封顶**：最多 2 层（Agent → Subagent），防止无限递归
 * 4. **只读默认**：Subagent 默认只读。要写必须显式给 writeScope
 * 5. **步数封顶**：单次 Subagent 最多 15 步，防止一个子任务烧光预算
 * 6. **超时**：超过 3 分钟强制结束
 */
import type { LlmClient } from '../llm/types.js';
import type { ChatMessage } from '../llm/types.js';
import { runLoop } from '../session/loop.js';
import type { ToolHost } from '../session/loop.js';

/** Subagent 最多跑多少步。 */
export const SUBAGENT_MAX_STEPS = 15;
/** Subagent 默认超时（毫秒）。 */
export const SUBAGENT_TIMEOUT_MS = 3 * 60_000;
/** 最多嵌套几层。 */
export const MAX_SUBAGENT_DEPTH = 2;

export interface SubagentOptions {
  readonly llm: LlmClient;
  /** 子 Agent 能用的工具集（通常和父 Agent 相同，但**不含 spawn_subagent 本身**）。 */
  readonly toolHost: ToolHost;
  /** 子任务目标。 */
  readonly task: string;
  /** 父 Agent 的上下文摘要（让它不至于一无所知）。 */
  readonly context?: string;
  readonly signal: AbortSignal;
  /** 当前深度（父 Agent 是 1，它的 Subagent 是 2）。 */
  readonly depth: number;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
}

export interface SubagentResult {
  readonly ok: boolean;
  /** 子 Agent 的最终答复。 */
  readonly content: string;
  /** 实际跑了几步。 */
  readonly steps: number;
  /** 是否因为超时/步数上限被截断。 */
  readonly truncated: boolean;
}

/**
 * 跑一个子 Agent，等它结束后返回最终文本。
 *
 * 中间的工具调用和思考**不返回**——父 Agent 只需要结论。
 * 这是刻意的：把子 Agent 的全部轨迹塞回父上下文，就失去了"隔离"的意义。
 */
export async function runSubagent(options: SubagentOptions): Promise<SubagentResult> {
  if (options.depth >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      content:
        `已经嵌套 ${options.depth} 层，不能再派子 Agent。\n` +
        '请自己完成这个子任务，或者把它作为结论的一部分交给上层。',
      steps: 0,
      truncated: false,
    };
  }

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        '你是一个子 Agent，只负责完成交给你的**这一件子任务**。\n' +
        '你看不到用户和上层 Agent 的完整对话。\n\n' +
        '要求：\n' +
        '- 专注做完这件事，不要扩展范围\n' +
        '- 结束时用一段话给出**结论**（上层需要的是结论，不是过程）\n' +
        '- 如果没做完或做不到，直接说明原因\n' +
        '- 不要调用 spawn_subagent（不能再嵌套）',
    },
    {
      role: 'user',
      content: options.context
        ? `背景：\n${options.context}\n\n你的任务：\n${options.task}`
        : options.task,
    },
  ];

  const timeoutMs = options.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let lastText = '';
  let steps = 0;
  let truncated = false;

  try {
    const stream = runLoop({
      llm: options.llm,
      toolHost: options.toolHost,
      messages,
      maxSteps: options.maxSteps ?? SUBAGENT_MAX_STEPS,
      signal: controller.signal,
    });

    for await (const event of stream) {
      // done 事件带最终文本和步数——这是我们要的唯一东西
      if (event.type === 'done') {
        lastText = event.finalText;
        steps = event.steps;
      }
      if (event.type === 'error') {
        // 达到步数上限也算截断
        if (/maxSteps|步数|上限/.test(event.message)) truncated = true;
      }
    }
  } catch (error) {
    return {
      ok: false,
      content: `子 Agent 执行出错：${error instanceof Error ? error.message : String(error)}`,
      steps,
      truncated: false,
    };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }

  if (controller.signal.aborted) {
    return {
      ok: false,
      content: lastText
        ? `子 Agent 被中断（可能是超时或用户停止）。它最后说的是：\n${lastText}`
        : '子 Agent 被中断（可能是超时或用户停止），没有产出结论。',
      steps,
      truncated: true,
    };
  }

  return {
    ok: lastText.trim().length > 0,
    content: lastText.trim() || '子 Agent 结束了，但没有给出任何结论。',
    steps,
    truncated,
  };
}
