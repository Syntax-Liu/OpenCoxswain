import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { AppError } from '../errors.js';

/** Telegram update 很小，256KB 足够，避免被大包拖垮。 */
const MAX_BODY = 256 * 1024;
/** 只记住最近一批 update_id，够覆盖 Telegram 的重试窗口。 */
const SEEN_LIMIT = 500;

export interface TelegramSendInput {
  botToken: string;
  chatId: string;
  text: string;
  fetchImpl?: typeof fetch;
}

export async function sendTelegramMessage(input: TelegramSendInput): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `https://api.telegram.org/bot${input.botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram 返回 HTTP ${response.status}：${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram 返回非 JSON：${raw.slice(0, 200)}`);
  }
  const result = asRecord(parsed);
  if (result.ok !== true) {
    const description = typeof result.description === 'string' ? result.description : '未知错误';
    throw new Error(`Telegram 返回失败：${description}`);
  }
}

/** 只处理文本消息；图片、贴纸、编辑记录直接忽略。 */
export function extractTelegramText(body: unknown): string | null {
  const message = asRecord(asRecord(body).message);
  return typeof message.text === 'string' ? message.text : null;
}

/** 取出消息所在会话的 id；用于确认消息确实来自已绑定的会话。 */
export function telegramChatId(body: unknown): string | null {
  const chat = asRecord(asRecord(asRecord(body).message).chat);
  if (typeof chat.id === 'number') return String(chat.id);
  if (typeof chat.id === 'string') return chat.id;
  return null;
}

/** update_id 用于去重：Telegram 没收到 200 会重投同一条更新。 */
export function telegramUpdateId(body: unknown): number | null {
  const value = asRecord(body).update_id;
  return typeof value === 'number' ? value : null;
}

export function apply(ctx: PluginContext): void {
  const channels = ctx.service('channels');
  const http = ctx.service('http');
  const seen = new Set<number>();

  ctx.effect(
    channels.registerTransport('telegram', {
      send: ({ botToken, chatId, text }) =>
        sendTelegramMessage({ botToken: botToken ?? '', chatId: chatId ?? '', text }),
    }),
  );

  http.rawRoute('POST', '/api/channels/:id/inbound/telegram', async (req, res, _url, params) => {
    const channelId = params.id ?? '';
    try {
      const channel = channels.get(channelId);
      if (!channel || channel.kind !== 'telegram') {
        reply(res, 404, { ok: false, description: '通道不存在' });
        return;
      }
      // setWebhook 时把入站 token 填成 secret_token，Telegram 会原样带回请求头。
      const secret = header(req, 'x-telegram-bot-api-secret-token');
      if (channel.inboundToken === '' || secret !== channel.inboundToken) {
        reply(res, 401, { ok: false, description: 'secret_token 不匹配' });
        return;
      }

      const parsed = parseBody(await readBody(req));
      const updateId = telegramUpdateId(parsed);
      if (updateId !== null) {
        if (seen.has(updateId)) {
          reply(res, 200, { ok: true });
          return;
        }
        seen.add(updateId);
        if (seen.size > SEEN_LIMIT) {
          const oldest = seen.values().next();
          if (!oldest.done) seen.delete(oldest.value);
        }
      }

      const chatId = telegramChatId(parsed);
      const text = extractTelegramText(parsed);
      // 机器人可能被陌生人私聊，只处理绑定会话里的指令。
      if (text === null || chatId === null || chatId !== channel.chatId) {
        reply(res, 200, { ok: true });
        return;
      }

      const result = await channels.inbound(channel.id, text);
      reply(res, 200, { ok: true });
      void channels.sendText(channel.id, result.reply);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 400;
      reply(res, status, { ok: false, description: errorText(error) });
    }
  });
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    throw new AppError('请求体不是合法 JSON');
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('请求体过大', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
