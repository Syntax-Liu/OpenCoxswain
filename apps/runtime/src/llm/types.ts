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

/**
 * 多模态内容块。
 *
 * ## 为什么需要
 *
 * `content: string` 发不了图片。用户截图报错、贴设计稿这类场景
 * 根本做不到——只能让它自己去找文件。
 *
 * ## 兼容性设计
 *
 * `ChatMessage.content` 保持 `string` 为最常用形态，只在**真的要发图片**时
 * 才用数组。这样：
 * - 已有几百处 `content: 'xxx'` 的代码一行不用改
 * - 纯文本请求的报文和以前完全一样（不会有任何行为变化）
 *
 * ## 只在模型支持时使用
 *
 * 模型是否支持图片由 `ModelParams.supportsImages` 决定。
 * **不支持的模型绝不能收到图片块**——多数端点会直接 400。
 * 这部分由 `toWireMessages` 统一过滤，不靠调用方自觉。
 */
export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImagePart {
  readonly type: 'image';
  /** `data:image/png;base64,...` 形式的完整 data URL。 */
  readonly dataUrl: string;
  /** 原始文件名，仅用于展示与日志，不发给模型。 */
  readonly name?: string;
}

export type ContentPart = TextPart | ImagePart;

/** 消息内容：纯文本，或带图片的多模态数组。 */
export type MessageContent = string | readonly ContentPart[];

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** 仅 assistant 消息：本步要调的工具。 */
  tool_calls?: ChatToolCallPayload[];
  /** 仅 tool 消息：回填给哪个调用。 */
  tool_call_id?: string;
  /**
   * 多模态内容。**设置后优先于 `content`。**
   *
   * 为什么不用 `content` 直接存数组：改它的类型会让几百处调用点全部报错，
   * 而其中真正需要图片的不到 1%。单独一个字段把改动面控制在这里。
   */
  parts?: readonly ContentPart[];
  /**
   * 思考模式的思维链。
   *
   * ## 为什么必须回传
   *
   * DeepSeek 文档（思考模式 → 工具调用）：
   *
   * > 携带了 `tools` 参数的请求，在后续所有请求中，**必须完整回传
   * > `reasoning_content`** ——即使该轮模型未实际进行工具调用。
   * > 若您的代码中未正确回传，API 会返回 400 报错。
   *
   * 而 `deepseek-flash` 的思考模式**默认打开**。所以：
   *
   *   模型在思考模式下想调工具
   *   → 我们没存 reasoning_content
   *   → 下一轮请求缺它
   *   → API 400
   *   → 工具循环整个断掉
   *
   * ## 表现
   *
   * 不是显式报错，而是**模型学会了只写文字、不调工具**——
   * 用户看到的是"Assistant 很难主动派活，要说很多次"。
   *
   * 用户实测（2026-11-15）：说"需要"说了 6 次才派出一个。
   */
  reasoning_content?: string;
}

/** 取出一条消息的纯文本部分（用于估算 token、落库、日志）。 */
export function textOf(message: ChatMessage): string {
  if (message.parts && message.parts.length > 0) {
    return message.parts
      .filter((p): p is TextPart => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  return message.content ?? '';
}

/** 一条消息里有没有图片。 */
export function hasImages(message: ChatMessage): boolean {
  return (message.parts ?? []).some((p) => p.type === 'image');
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
  /**
   * 思考模式的思维链。
   *
   * **必须在下一轮请求里原样回传**（见 ChatMessage.reasoning_content）。
   * 不传的话，带 tools 的后续请求会被 API 以 400 拒绝，
   * 工具循环整个断掉——表现就是"模型不肯调工具"。
   */
  readonly reasoningContent?: string;
}

export interface LlmClient {
  readonly name: string;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  /**
   * 流式对话：文字边生成边通过 `onDelta` 吐出来。
   *
   * ## 为什么单开一个方法而不是给 chat 加参数
   *
   * `chat` 有几十个调用点（验收、摘要、记忆……），它们只要最终结果。
   * 加参数会让每个调用点都要想"传不传 onDelta"。
   *
   * 单开一个方法，只有真正需要流式的地方（用户看得见的对话）才用它。
   *
   * ## 返回值和 chat 完全一样
   *
   * 流式只是"提前看到过程"，最终结果的结构不变：
   * 照样有 text / toolCalls / usage / reasoningContent。
   *
   * **可选**：不实现就退回非流式（老 client 不用改）。
   */
  chatStream?(
    request: LlmChatRequest,
    onDelta: (text: string) => void,
  ): Promise<LlmChatResponse>;
}

/** 会话里持久化的一条消息（比 ChatMessage 多时间与来源，供 UI 与审计）。 */
export interface AgentMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  /** 这条消息从哪来：用户 / 助理 / 系统 / Agent汇报 / Supervisor转交。 */
  readonly source: string;
  readonly at: number;
  /**
   * 图片附件。**落库保存**，这样刷新或重启后历史里还能看到图。
   *
   * 是否真的发给模型由模型能力决定（见 `toWireMessages`）——
   * 存下来和发出去是两件事：不支持图片的模型也能看到"用户发过一张图"。
   */
  readonly images?: readonly ContentPart[];
}

export interface LlmConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** 请求超时，默认 120s。 */
  readonly timeoutMs?: number;
  /**
   * 这个模型能不能看图。**默认 false**。
   *
   * 保守默认的理由：发了图片却被端点 400，用户看到"发送失败"
   * 但不知道原因。宁可降级成"只收到文件名"，也不要不可预期的失败。
   */
  readonly supportsImages?: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * OpenAI 兼容客户端。
 *
 * 刻意保持极简：只做 /chat/completions 的往返与错误归类，
 * 重试与降级由上层决定（避免在传输层偷偷重试，掩盖真实失败）。
 */
/**
 * 把内部消息转成 API 报文。
 *
 * ## 为什么必须有这一步
 *
 * 内部消息可能带 `parts`（图文混合）。但**模型不一定支持图片**——
 * 多数端点收到图片块会直接 400，用户看到的是"发送失败"，不知道原因。
 *
 * 所以在这里统一处理：
 * - 支持图片 → 转成 OpenAI 的 `content: [{type:'text'},{type:'image_url'}]`
 * - 不支持 → 图片降级成一行文字说明，**并告知用户模型看不了图**
 *
 * 放在这个函数里而不是各调用点，是因为"不支持的模型绝不能收到图片块"
 * 这条约束不能靠调用方自觉。
 */
export function toWireMessages(
  messages: readonly ChatMessage[],
  options: { readonly supportsImages: boolean },
): unknown[] {
  return messages.map((message) => {
    const base: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.tool_calls) base.tool_calls = message.tool_calls;
    if (message.tool_call_id) base.tool_call_id = message.tool_call_id;

    // **思维链必须回传**。
    //
    // DeepSeek 文档：带 tools 的请求，后续每一轮都必须完整回传
    // `reasoning_content`，否则 API 返回 400。
    //
    // 不回传的后果不是显式报错，而是**工具循环整轮崩掉**——
    // 用户看到的是"Assistant 不肯派活，要说很多次"。
    if (message.reasoning_content) base.reasoning_content = message.reasoning_content;

    // 没有多模态内容：原样返回（和以前完全一致，零行为变化）
    if (!message.parts || message.parts.length === 0) return base;

    const texts = message.parts.filter((p): p is TextPart => p.type === 'text').map((p) => p.text);
    const images = message.parts.filter((p): p is ImagePart => p.type === 'image');

    if (options.supportsImages && images.length > 0) {
      // 支持图片：走标准的多模态数组
      base.content = [
        ...texts.map((t) => ({ type: 'text', text: t })),
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: img.dataUrl },
        })),
      ];
      return base;
    }

    // 不支持图片（或没图片）：拼成纯文本，把图片降级成说明
    const degraded = images.map(
      (img) => `〔图片 ${img.name ?? '未命名'}：当前模型不支持读取图片，只收到了文件名〕`,
    );
    base.content = [...texts, ...degraded].join('\n');
    return base;
  });
}

export class OpenAiCompatClient implements LlmClient {
  readonly name = 'openai-compat';

  constructor(private readonly config: LlmConfig) {}

  /** 构造请求体。流式和非流式共用，避免两处漂移。 */
  private buildBody(request: LlmChatRequest, stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      // supportsImages 默认 false：**保守**。没声明支持的模型一律按不支持处理，
      // 避免"发了图片被 400"这种不可预期的失败。
      messages: toWireMessages(request.messages, {
        supportsImages: this.config.supportsImages === true,
      }),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;
    if (stream) {
      body.stream = true;
      // 要求服务端在最后一个 chunk 带上 usage，否则流式拿不到 token 数。
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /**
   * 流式对话。
   *
   * ## 为什么需要
   *
   * 2026-11-16 用户实测：
   *
   * > 整一段一次性蹦出
   * > 不能在我发送第一条的时候马上回复（即使不能马上回复也应该留个对话框占个位）
   *
   * 原来 `chat` 是等整段生成完才返回，用户对着空屏幕等几十秒。
   *
   * ## 怎么拼起来
   *
   * 服务端发的是 SSE，每个 `data:` 是一小块。文字在
   * `choices[0].delta.content`，工具调用在 `delta.tool_calls`
   * （**分多次到达，要按 index 拼参数**）。
   *
   * 拼完之后返回的结构和 `chat` 完全一样——上层不用区分。
   */
  async chatStream(
    request: LlmChatRequest,
    onDelta: (text: string) => void,
  ): Promise<LlmChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(this.buildBody(request, true)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${truncate(detail, 500)}`);
      }
      if (!response.body) {
        throw new Error('服务端没有返回流');
      }

      let text = '';
      let reasoning = '';
      // 工具调用按 index 累积：一个调用可能分好几个 chunk 传参数。
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage: Record<string, unknown> = {};

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件。最后一段可能不完整，留在 buffer 里等下次。
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf('\n\n');

          for (const line of raw.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let chunk: {
              choices?: Array<{
                delta?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
              usage?: Record<string, unknown>;
            };
            try {
              chunk = JSON.parse(data);
            } catch {
              continue; // 半个 chunk，跳过
            }

            // usage 通常只在最后一个 chunk 里（stream_options.include_usage）。
            if (chunk.usage) usage = chunk.usage;

            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.reasoning_content) reasoning += delta.reasoning_content;

            if (delta.content) {
              text += delta.content;
              // **逐块吐给上层**：这是流式的全部意义。
              onDelta(delta.content);
            }

            for (const call of delta.tool_calls ?? []) {
              const idx = call.index ?? 0;
              const prev = calls.get(idx) ?? { id: '', name: '', args: '' };
              calls.set(idx, {
                // id 和 name 只在第一块出现，后面是空的——空值不要覆盖。
                id: call.id ?? prev.id,
                name: call.function?.name ?? prev.name,
                args: prev.args + (call.function?.arguments ?? ''),
              });
            }
          }
        }
      }

      const toolCalls: LlmToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({
          id: c.id || `call_${index}`,
          name: c.name || 'unknown',
          args: parseArgs(c.args),
        }));

      const cached = readCachedTokens(usage);
      return {
        text,
        toolCalls,
        tokensIn: Number(usage.prompt_tokens) || 0,
        tokensOut: Number(usage.completion_tokens) || 0,
        ...(cached !== undefined ? { cachedTokens: cached } : {}),
        ...(reasoning ? { reasoningContent: reasoning } : {}),
      };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    }
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? DEFAULT_TIMEOUT);
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const body = this.buildBody(request);

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
            /** 思考模式的思维链。**下一轮必须原样回传**。 */
            reasoning_content?: string | null;
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
        // 思维链要留到下一轮（带 tools 的请求必须回传，否则 400）。
        ...(typeof message.reasoning_content === 'string'
          ? { reasoningContent: message.reasoning_content }
          : {}),
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
