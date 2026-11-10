import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  HttpHandler,
  HttpRawHandler,
  HttpReply,
  HttpRouteRequest,
  HttpService,
  PluginContext,
} from '@opencoxswain/plugin-api';
import { AppError } from '../errors.js';

const MAX_BODY = 2 * 1024 * 1024;

interface CompiledRoute<T> {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: T;
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function paramsOf(keys: string[], match: RegExpExecArray): Record<string, string> {
  const params: Record<string, string> = {};
  keys.forEach((key, index) => {
    const value = match[index + 1];
    if (value !== undefined) params[key] = decodeURIComponent(value);
  });
  return params;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new AppError('请求体过大', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('请求体不是合法 JSON');
  }
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendReply(res: ServerResponse, reply: HttpReply): void {
  const headers = { ...CORS, ...(reply.headers ?? {}) };
  if (reply.json !== undefined) {
    const body = JSON.stringify(reply.json);
    res.writeHead(reply.status ?? 200, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  if (reply.text !== undefined) {
    res.writeHead(reply.status ?? 200, {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(reply.text),
    });
    res.end(reply.text);
    return;
  }
  res.writeHead(reply.status ?? 204, headers);
  res.end();
}

export function apply(ctx: PluginContext): void {
  const config = ctx.service('config');
  const routes: Array<CompiledRoute<HttpHandler>> = [];
  const rawRoutes: Array<CompiledRoute<HttpRawHandler>> = [];
  let server: ReturnType<typeof createServer> | null = null;
  let boundPort = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Last-Event-ID',
      });
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const method = req.method ?? 'GET';

      for (const route of rawRoutes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        await route.handler(req, res, url, paramsOf(route.keys, match));
        return;
      }

      for (const route of routes) {
        if (route.method !== method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        const request: HttpRouteRequest = {
          params: paramsOf(route.keys, match),
          query: url.searchParams,
          body: await readJson(req),
          req,
        };
        sendReply(res, await route.handler(request));
        return;
      }

      throw new AppError('接口不存在', 404);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof AppError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const service: HttpService = {
    route(method, pattern, handler) {
      const compiled = compile(pattern);
      const entry: CompiledRoute<HttpHandler> = { method: method.toUpperCase(), ...compiled, handler };
      routes.push(entry);
      return () => {
        const index = routes.indexOf(entry);
        if (index >= 0) routes.splice(index, 1);
      };
    },
    rawRoute(method, pattern, handler) {
      const compiled = compile(pattern);
      const entry: CompiledRoute<HttpRawHandler> = { method: method.toUpperCase(), ...compiled, handler };
      rawRoutes.push(entry);
      return () => {
        const index = rawRoutes.indexOf(entry);
        if (index >= 0) rawRoutes.splice(index, 1);
      };
    },
    async listen(port) {
      if (server) throw new Error('HTTP 服务已启动');
      const instance = createServer((req, res) => void handle(req, res));
      await new Promise<void>((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(port, config.host, () => resolve());
      });
      const address = instance.address();
      boundPort = typeof address === 'object' && address !== null ? address.port : port;
      server = instance;
      return boundPort;
    },
    port() {
      return boundPort;
    },
    async close() {
      const instance = server;
      if (!instance) return;
      server = null;
      boundPort = 0;
      await new Promise<void>((resolve) => {
        instance.close(() => resolve());
        instance.closeAllConnections();
      });
    },
  };

  ctx.provide('http', service);
  ctx.on('kernel.ready', async () => {
    await service.listen(config.port);
  });
  ctx.effect(() => service.close());
}
