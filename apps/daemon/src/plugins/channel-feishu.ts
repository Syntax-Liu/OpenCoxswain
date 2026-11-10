import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginContext } from '@opencoxswain/plugin-api';
import { AppError } from '../errors.js';

/** 飞书事件回调很小，给 256KB 足够，避免被大包拖垮。 */
const MAX_BODY = 256 * 1024;

/**
 * 飞书自定义机器人签名：以 `${timestamp}\n${secret}` 为密钥，
 * 对空串做 HMAC-SHA256 后 base64。
 */
export function feishuSign(secret: string, timestamp: number): string {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

export interface FeishuSendInput {
  webhookUrl: string;
  secret: string;
  text: string;
  timestamp?: number;
  fetchImpl?: typeof fetch;
}

export async function sendFeishuMessage(input: FeishuSendInput): Promise<void> {
  const body: Record<string, unknown> = {
    msg_type: 'text',
    content: { text: input.text },
  };
  if (input.secret.trim() !== '') {
    const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp);
    body.sign = feishuSign(input.secret, timestamp);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`飞书返回 HTTP ${response.status}：${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非 JSON 响应（如网关错误页）按成功处理没有意义，直接报错。
    throw new Error(`飞书返回非 JSON：${raw.slice(0, 200)}`);
  }
  const result = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = result.code ?? result.StatusCode;
  if (code !== undefined && code !== 0) {
    const message = result.msg ?? result.StatusMessage ?? '未知错误';
    throw new Error(`飞书返回 ${String(code)}：${String(message)}`);
  }
}

/** 事件订阅开启 Encrypt Key 时，回调体是 AES-256-CBC 加密后的 base64。 */
export function decryptFeishu(encryptKey: string, cipherText: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const buffer = Buffer.from(cipherText, 'base64');
  if (buffer.length <= 16) throw new Error('加密内容长度不合法');
  const iv = buffer.subarray(0, 16);
  const data = buffer.subarray(16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** X-Lark-Signature = sha256(timestamp + nonce + encryptKey + rawBody)。 */
export function feishuInboundSignature(
  encryptKey: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return createHash('sha256')
    .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
    .digest('hex');
}

/** 只处理文本消息；其他类型（图片、卡片）直接忽略。 */
export function extractFeishuText(body: unknown): string | null {
  const event = asRecord(asRecord(body).event);
  const message = asRecord(event.message);
  if (message.message_type !== undefined && message.message_type !== 'text') return null;
  if (typeof message.content !== 'string') return null;
  try {
    const content = asRecord(JSON.parse(message.content));
    return typeof content.text === 'string' ? content.text : null;
  } catch {
    return null;
  }
}

export function apply(ctx: PluginContext): void {
  const channels = ctx.service('channels');
  const http = ctx.service('http');

  ctx.effect(
    channels.registerTransport('feishu', {
      send: ({ webhookUrl, secret, text }) =>
        sendFeishuMessage({ webhookUrl, secret, text }),
    }),
  );

  http.rawRoute('POST', '/api/channels/:id/inbound', async (req, res, url, params) => {
    const channelId = params.id ?? '';
    try {
      const channel = channels.get(channelId);
      if (!channel || channel.kind !== 'feishu') {
        reply(res, 404, { code: -1, msg: '通道不存在' });
        return;
      }
      const rawBody = await readBody(req);
      const signature = header(req, 'x-lark-signature');
      if (signature !== '') {
        const timestamp = header(req, 'x-lark-request-timestamp');
        const nonce = header(req, 'x-lark-request-nonce');
        if (timestamp === '' || nonce === '') {
          reply(res, 401, { code: -1, msg: '缺少签名时间戳或随机串' });
          return;
        }
        const expected = feishuInboundSignature(
          channel.inboundToken,
          timestamp,
          nonce,
          rawBody,
        );
        if (expected !== signature) {
          reply(res, 401, { code: -1, msg: '签名不匹配' });
          return;
        }
      } else if (url.searchParams.get('token') !== channel.inboundToken) {
        // 没开事件订阅签名时，用 URL token 兜底，避免成为无鉴权的公网入口。
        reply(res, 401, { code: -1, msg: '缺少签名或 token' });
        return;
      }

      const parsed = parseBody(rawBody, channel.inboundToken);
      if (typeof parsed.challenge === 'string') {
        reply(res, 200, { challenge: parsed.challenge });
        return;
      }
      const text = extractFeishuText(parsed);
      if (text === null) {
        reply(res, 200, { code: 0, msg: 'ignored' });
        return;
      }
      const result = await channels.inbound(channel.id, text);
      reply(res, 200, { code: 0, msg: 'ok' });
      // 回执走 webhook 回群，和通知同一条链路；失败已记录在通道状态里。
      void channels.sendText(channel.id, result.reply);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 400;
      reply(res, status, { code: -1, msg: errorText(error) });
    }
  });
}

function parseBody(raw: string, encryptKey: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('请求体不是合法 JSON');
  }
  const record = asRecord(parsed);
  if (typeof record.encrypt === 'string') {
    return asRecord(JSON.parse(decryptFeishu(encryptKey, record.encrypt)));
  }
  return record;
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
