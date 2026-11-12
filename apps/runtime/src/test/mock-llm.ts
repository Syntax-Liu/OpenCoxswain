/**
 * 测试替身：脚本化的 LLM 客户端。
 *
 * 有了它，整条链路（用户 → C → D → 文件 → 汇报）可以在纯内存里跑通，
 * 不需要网络、不需要真实模型。这是自研运行时能被验证的关键。
 */
import type {
  ChatMessage,
  LlmChatRequest,
  LlmChatResponse,
  LlmClient,
  LlmToolCall,
} from '../llm/types.js';

/** 一次模型响应的脚本。 */
export type ScriptedResponse =
  | { readonly text: string }
  | { readonly tool: string; readonly args?: Record<string, unknown>; readonly text?: string }
  | { readonly tools: ReadonlyArray<{ readonly name: string; readonly args?: Record<string, unknown> }>; readonly text?: string };

/**
 * 按"第几次调用"或"谁在调用"返回脚本。
 *
 * `script` 可以是一个函数，拿到完整请求，便于实现"看到结算通知就汇报"这种
 * 依赖上下文的假模型。
 */
export type ScriptFn = (request: LlmChatRequest) => ScriptedResponse | Promise<ScriptedResponse>;

/** 可覆盖的用量，用来模拟"烧 token"的执行者。 */
export interface MockUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cachedTokens?: number;
}

export class MockLlmClient implements LlmClient {
  readonly name = 'mock';
  readonly calls: ChatMessage[][] = [];
  private readonly script: ScriptFn;
  private readonly usage: MockUsage;

  constructor(script: ScriptFn, usage: MockUsage = { tokensIn: 10, tokensOut: 5 }) {
    this.script = script;
    this.usage = usage;
  }

  private usageFields(): Pick<LlmChatResponse, 'tokensIn' | 'tokensOut' | 'cachedTokens'> {
    return {
      tokensIn: this.usage.tokensIn,
      tokensOut: this.usage.tokensOut,
      ...(this.usage.cachedTokens !== undefined ? { cachedTokens: this.usage.cachedTokens } : {}),
    };
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.calls.push([...request.messages]);
    const planned = await this.script(request);

    if ('tool' in planned) {
      const call: LlmToolCall = {
        id: `call_${this.calls.length}`,
        name: planned.tool,
        args: planned.args ?? {},
      };
      return {
        text: planned.text ?? '',
        toolCalls: [call],
        ...this.usageFields(),
      };
    }

    if ('tools' in planned) {
      return {
        text: planned.text ?? '',
        toolCalls: planned.tools.map((t, i) => ({
          id: `call_${this.calls.length}_${i}`,
          name: t.name,
          args: t.args ?? {},
        })),
        ...this.usageFields(),
      };
    }

    return { text: planned.text, toolCalls: [], ...this.usageFields() };
  }
}

/** 取最后一条 user 消息的文本，方便脚本判断当前处境。 */
export function lastUserText(request: LlmChatRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i]!;
    if (m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

/** 判断当前请求是不是"Assistant 收到的执行者结算通知"。 */
export function isSettlementNotice(request: LlmChatRequest): boolean {
  return lastUserText(request).includes('【执行者结算】');
}

/** 判断当前请求是不是"执行者（Agent） 的工作轮"。 */
export function isExecutorTurn(request: LlmChatRequest): boolean {
  const system = request.messages.find((m) => m.role === 'system');
  // 必须用 Agent 提示词独有的开头，不能用"你是执行者"——Assistant 的提示词里也会提到执行者。
  return typeof system?.content === 'string' && system.content.startsWith('你是执行者。');
}

/** 判断当前请求是不是 Assistant 在回应普通用户消息。 */
export function isAssistantTurn(request: LlmChatRequest): boolean {
  const system = request.messages.find((m) => m.role === 'system');
  return typeof system?.content === 'string' && system.content.startsWith('你是这个项目的「Assistant」');
}
