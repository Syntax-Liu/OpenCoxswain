/**
 * LLM 抽象层。
 *
 * 自研运行时只依赖这一个接口，不绑定任何供应商：
 * - `OpenAiCompatClient` 是默认实现（DeepSeek / OpenAI / 任何兼容端点）；
 * - 测试用 `MockLlmClient` 注入脚本化的响应，无需网络即可跑通整条链路。
 *
 * 为什么单独抽一层：legacy 的 `builtin.ts` 把 HTTP 细节和循环混在一起，
 * 导致没法在测试里跑真实对话流程。这里拆开后，Assistant 和 Agent 的会话循环可以在
 * 纯内存里被完整验证。
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCallPayload {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** 仅 assistant 消息：本步要调的工具。 */
  tool_calls?: ChatToolCallPayload[];
  /** 仅 tool 消息：回填给哪个调用。 */
  tool_call_id?: string;
}

/** 面向模型的工具定义（OpenAI function 形态）。 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema。 */
  readonly parameters: Record<string, unknown>;
}

/** 循环内部用的工具调用（已解析好参数）。 */
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface LlmChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly signal: AbortSignal;
}

export interface LlmChatResponse {
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * 缓存命中的输入 token。
   *
   * 各家字段名不同（DeepSeek / OpenAI 用 `prompt_cache_hit_tokens` 或
   * `prompt_tokens_details.cached_tokens`），**都没给时为 undefined**——
   * "没有这个数据"不能当成 0。
   */
  readonly cachedTokens?: number;
}

export interface LlmClient {
  readonly name: string;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
}

/** 会话里持久化的一条消息（比 ChatMessage 多时间与来源，供 UI 与审计）。 */
export interface AgentMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  /** 这条消息从哪来：用户 / 助理 / 系统 / Agent汇报 / Supervisor转交。 */
  readonly source: string;
  readonly at: number;
}

export interface LlmConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** 请求超时，默认 120s。 */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * OpenAI 兼容客户端。
 *
 * 刻意保持极简：只做 /chat/completions 的往返与错误归类，
 * 重试与降级由上层决定（避免在传输层偷偷重试，掩盖真实失败）。
 */
export class OpenAiCompatClient implements LlmClient {
  readonly name = 'openai-compat';

  constructor(private readonly config: LlmConfig) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: request.messages,
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
      if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${truncate(detail, 500)}`);
      }

      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: Record<string, unknown>;
      };

      const message = json.choices?.[0]?.message ?? {};
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls: LlmToolCall[] = rawCalls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? 'unknown',
        args: parseArgs(call.function?.arguments),
      }));

      const usage = json.usage ?? {};
      const cached = readCachedTokens(usage);

      return {
        text: message.content ?? '',
        toolCalls,
        tokensIn: Number(usage.prompt_tokens) || 0,
        tokensOut: Number(usage.completion_tokens) || 0,
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }
  }
}

/** 参数解析失败不抛错：返回空对象，让模型自己收到工具报错后纠正。 */
/**
 * 从 usage 里读出缓存命中 token。
 *
 * 各家字段不同，按常见顺序探测：
 * - DeepSeek：`prompt_cache_hit_tokens`
 * - OpenAI：`prompt_tokens_details.cached_tokens`
 * - Anthropic 兼容层有时是 `cache_read_input_tokens`
 *
 * 都读不到时返回 **undefined**，上层据此显示"未提供"而不是 0%。
 */
function readCachedTokens(usage: Record<string, unknown>): number | undefined {
  const direct = usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  const details = usage.prompt_tokens_details;
  if (details && typeof details === 'object') {
    const cached = (details as Record<string, unknown>).cached_tokens;
    if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
  }
  return undefined;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
