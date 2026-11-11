/**
 * Telegram Bot 客户端（零依赖，用内置 fetch）。
 *
 * 为什么选 Telegram 先做：API 极简、不需要企业认证、长轮询天然适合本地软件
 * （不用公网 IP、不用 webhook 回调）。飞书要企业自建应用 + 公网回调，重得多。
 *
 * 这里只做通道本身该做的事：收消息、发消息、发按钮、回按钮。
 * **不包含任何业务逻辑**——业务在 bridge 里，保证 IM 和 Web 走同一条路径。
 */

export interface TelegramConfig {
  readonly botToken: string;
  /** 允许对话的 chat id 白名单。空表示尚未绑定。 */
  readonly chatIds: readonly string[];
  /** 绑定的项目。未绑定时消息会被拒绝并提示先绑定。 */
  readonly projectId: string | null;
}

export interface TelegramMessage {
  readonly chatId: string;
  readonly text: string;
  readonly fromName: string;
  readonly at: number;
}

export interface InlineButton {
  readonly text: string;
  /** 回调数据，形如 `approve:apr_xxx` / `reject:apr_xxx`。 */
  readonly data: string;
}

export interface CallbackQuery {
  readonly id: string;
  readonly chatId: string;
  readonly data: string;
  readonly fromName: string;
}

const API = 'https://api.telegram.org';

/** 把 Telegram 的更新对象抽成我们关心的两种事件。 */
export interface ParsedUpdates {
  readonly messages: TelegramMessage[];
  readonly callbacks: CallbackQuery[];
  /**
   * 本批最大的 update_id。
   *
   * **必须用它来推进 offset**（下一轮传 maxUpdateId + 1），
   * 否则 Telegram 会把同一批消息重复推过来——用"处理了几条"来推进是错的。
   */
  readonly maxUpdateId: number | null;
}

/**
 * 解析 getUpdates 的返回。
 *
 * 单独抽出来是为了能脱网测试——真实接口的形状我用官方文档对齐，
 * 但不假装能在测试里跑通网络。
 */
export function parseUpdates(raw: unknown): ParsedUpdates {
  const messages: TelegramMessage[] = [];
  const callbacks: CallbackQuery[] = [];
  let maxUpdateId: number | null = null;
  if (!raw || typeof raw !== 'object') return { messages, callbacks, maxUpdateId };

  const result = (raw as { result?: unknown }).result;
  if (!Array.isArray(result)) return { messages, callbacks, maxUpdateId };

  for (const update of result) {
    if (!update || typeof update !== 'object') continue;
    const record = update as Record<string, unknown>;

    if (typeof record.update_id === 'number') {
      maxUpdateId = maxUpdateId === null ? record.update_id : Math.max(maxUpdateId, record.update_id);
    }

    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message === 'object') {
      const chat = message.chat as Record<string, unknown> | undefined;
      const text = message.text;
      if (chat && typeof text === 'string' && text.trim()) {
        const from = message.from as Record<string, unknown> | undefined;
        messages.push({
          chatId: String(chat.id),
          text,
          fromName: typeof from?.first_name === 'string' ? from.first_name : '用户',
          at: typeof message.date === 'number' ? message.date * 1000 : Date.now(),
        });
      }
    }

    const callback = record.callback_query as Record<string, unknown> | undefined;
    if (callback && typeof callback === 'object') {
      const chat = (callback.message as Record<string, unknown> | undefined)?.chat as
        | Record<string, unknown>
        | undefined;
      const from = callback.from as Record<string, unknown> | undefined;
      if (chat && typeof callback.data === 'string') {
        callbacks.push({
          id: String(callback.id),
          chatId: String(chat.id),
          data: callback.data,
          fromName: typeof from?.first_name === 'string' ? from.first_name : '用户',
        });
      }
    }
  }

  return { messages, callbacks, maxUpdateId };
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const json = (await response.json()) as { ok?: boolean; description?: string; result?: unknown };
    if (!response.ok || json.ok === false) {
      throw new Error(`Telegram ${method} 失败：${json.description ?? response.status}`);
    }
    return json.result as T;
  }

  /**
   * 长轮询拉取更新。
   *
   * `timeoutSec` 让服务器在没有新消息时挂住连接，避免空转打爆请求量。
   */
  async getUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<ParsedUpdates> {
    const result = await this.call<unknown>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    });
    void signal;
    return parseUpdates(result);
  }

  async sendMessage(
    chatId: string,
    text: string,
    buttons?: readonly (readonly InlineButton[])[],
  ): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(buttons && buttons.length > 0
        ? {
            reply_markup: {
              inline_keyboard: buttons.map((row) =>
                row.map((b) => ({ text: b.text, callback_data: b.data })),
              ),
            },
          }
        : {}),
    });
  }

  /** 回应按钮点击，避免客户端一直转圈。 */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackId,
      ...(text ? { text } : {}),
    });
  }

  /** 拿机器人自己的信息，用于设置页验证 token 是否有效。 */
  async getMe(): Promise<{ username: string }> {
    const me = await this.call<{ username?: string }>('getMe');
    return { username: me.username ?? 'bot' };
  }
}
