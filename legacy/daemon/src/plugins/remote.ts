import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { PluginContext } from '@opencoxswain/plugin-api';
import type { CostLedger } from '@opencoxswain/shared';
import { RemoteCoordinator } from '../remote.js';
import { AppError } from '../errors.js';

/** 单个代码包的体积上限；超过说明设计上应该改用追加式同步。 */
const MAX_BUNDLE = 64 * 1024 * 1024;

function bearer(req: IncomingMessage): string {
  const raw = req.headers.authorization ?? '';
  return /^Bearer\s+(.+)$/i.exec(raw)?.[1]?.trim() ?? '';
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BUNDLE) throw new AppError('代码包过大', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function apply(ctx: PluginContext): void {
  const config = ctx.service('config');
  const events = ctx.service('events');
  const http = ctx.service('http');

  const remote = new RemoteCoordinator({
    homeDir: config.homeDir,
    notify: (type, payload) => events.emit(type, payload),
  });
  ctx.provide('remote', remote);

  const sweeper = setInterval(() => remote.sweep(), 5_000);
  ctx.effect(() => clearInterval(sweeper));

  http.route('GET', '/api/remote', () => ({ json: remote.status() }));

  http.route('POST', '/api/remote/enable', () => ({ json: remote.enable() }));

  http.route('POST', '/api/remote/disable', () => ({ json: remote.disable() }));

  http.route('DELETE', '/api/remote/nodes/:id', ({ params }) => ({
    json: { ok: remote.removeNode(params.id ?? '') },
  }));

  http.route('POST', '/api/remote/register', ({ body }) => {
    const input = recordOf(body);
    const capabilities = Array.isArray(input.capabilities)
      ? input.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      json: remote.register({
        name: textField(input, 'name'),
        token: textField(input, 'token'),
        capabilities,
      }),
    };
  });

  http.route('POST', '/api/remote/nodes/:id/heartbeat', ({ params, body, req }) => {
    const token = bearer(req);
    const input = recordOf(body);
    const status = input.status === 'busy' ? 'busy' : 'idle';
    return { json: remote.heartbeat(params.id ?? '', token, { status }) };
  });

  http.rawRoute('GET', '/api/remote/jobs/:id/bundle', async (req, res, url, params) => {
    const nodeId = url.searchParams.get('nodeId') ?? '';
    if (!remote.verifyNode(nodeId, bearer(req))) throw new AppError('节点凭证无效', 401);
    const jobId = params.id ?? '';
    const job = remote.getJob(jobId);
    if (!job || job.nodeId !== nodeId) throw new AppError('远程任务不存在', 404);
    const file = remote.bundlePath(jobId);
    if (!file) throw new AppError('代码包不存在', 404);
    const size = statSync(file).size;
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  });

  http.rawRoute(
    'POST',
    '/api/remote/jobs/:id/result-bundle',
    async (req, res, url, params) => {
      const nodeId = url.searchParams.get('nodeId') ?? '';
      if (!remote.verifyNode(nodeId, bearer(req))) throw new AppError('节点凭证无效', 401);
      const data = await readBody(req);
      if (data.length === 0) throw new AppError('代码包为空');
      const job = remote.storeResultBundle(params.id ?? '', nodeId, data);
      const payload = JSON.stringify({ ok: true, bytes: data.length, jobId: job.id });
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    },
  );

  http.route('POST', '/api/remote/jobs/:id/complete', ({ params, body, req }) => {
    const input = recordOf(body);
    const nodeId = textField(input, 'nodeId');
    // 完成任务与领取任务同样需要节点凭证，避免只凭 nodeId 就能替别人收工。
    if (!remote.verifyNode(nodeId, bearer(req))) throw new AppError('节点凭证无效', 401);
    const ok = input.ok === true;
    const cost = (input.cost ?? null) as CostLedger | null;
    return {
      json: remote.complete(params.id ?? '', nodeId, {
        ok,
        summary: textField(input, 'summary') || (ok ? '远程执行完成' : '远程执行失败'),
        error: ok ? null : textField(input, 'error') || '节点报告失败',
        exitCode: typeof input.exitCode === 'number' ? input.exitCode : ok ? 0 : 1,
        log: textField(input, 'log'),
        cost,
      }),
    };
  });

  http.route('DELETE', '/api/remote/jobs/:id', ({ params }) => ({
    json: { ok: remote.cancelJob(params.id ?? '') },
  }));
}
