import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  CreatePlanRequest,
  CreateProjectRequest,
  EventRecord,
} from '@opencoxswain/shared';
import { EventBus } from './bus.js';
import type { DaemonConfig } from './config.js';
import { APP_VERSION } from './config.js';
import { AppError } from './errors.js';
import { Steward } from './steward.js';
import { Store } from './store.js';

export interface ApiServerOptions {
  store: Store;
  bus: EventBus;
  steward: Steward;
  config: DaemonConfig;
  health: () => Promise<{ ok: boolean; detail: string }>;
}

const MAX_BODY = 2 * 1024 * 1024;

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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = path.resolve(target).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export function createApiServer(options: ApiServerOptions): ReturnType<typeof createServer> {
  const { store, bus, steward, config, health } = options;

  const server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Last-Event-ID',
      });
      res.end();
      return;
    }

    try {
      await route(req, res);
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
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/api/health') {
      const status = await health();
      sendJson(res, 200, {
        ok: status.ok,
        version: APP_VERSION,
        adapter: 'mock',
        detail: status.detail,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/bootstrap') {
      const projectId = url.searchParams.get('projectId');
      sendJson(res, 200, await steward.snapshot(projectId));
      return;
    }

    if (method === 'GET' && pathname === '/api/events') {
      streamEvents(req, res, url);
      return;
    }

    if (method === 'POST' && pathname === '/api/projects') {
      const body = (await readJson(req)) as CreateProjectRequest;
      sendJson(res, 201, await steward.createProject(body));
      return;
    }

    const planMatch = pathname.match(/^\/api\/projects\/([^/]+)\/plan$/);
    if (method === 'POST' && planMatch) {
      const body = (await readJson(req)) as CreatePlanRequest;
      sendJson(res, 200, await steward.createPlan(planMatch[1]!, body));
      return;
    }

    const settingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/settings$/);
    if (method === 'POST' && settingsMatch) {
      const body = (await readJson(req)) as {
        dailyBudgetUsd?: number;
        maxConcurrency?: number;
      };
      sendJson(res, 200, steward.updateProjectSettings(settingsMatch[1]!, body));
      return;
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(approve|reject|cancel|accept|pause|resume)$/);
    if (method === 'POST' && taskMatch) {
      const taskId = taskMatch[1]!;
      const action = taskMatch[2]!;
      const body = action === 'reject' ? ((await readJson(req)) as { note?: string }) : {};
      let result;
      switch (action) {
        case 'approve':
          result = steward.approveTask(taskId);
          break;
        case 'reject':
          result = steward.rejectTask(taskId, (body as { note?: string }).note);
          break;
        case 'cancel':
          result = await steward.cancelTask(taskId);
          break;
        case 'accept':
          result = steward.acceptTask(taskId);
          break;
        case 'pause':
          result = await steward.pauseTask(taskId);
          break;
        case 'resume':
          result = await steward.resumeTask(taskId);
          break;
      }
      sendJson(res, 200, result);
      return;
    }

    const summaryMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/summary$/);
    if (method === 'GET' && summaryMatch) {
      sendJson(res, 200, { summary: steward.summary(summaryMatch[1]!) });
      return;
    }

    const replayMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/replay$/);
    if (method === 'GET' && replayMatch) {
      sendJson(res, 200, steward.replay(replayMatch[1]!));
      return;
    }

    const workerMatch = pathname.match(/^\/api\/workers\/([^/]+)\/(pause|resume|terminate)$/);
    if (method === 'POST' && workerMatch) {
      const worker = store.getWorker(workerMatch[1]!);
      if (!worker) throw new AppError('员工不存在', 404);
      const action = workerMatch[2]!;
      if (action === 'pause') await steward.pauseTask(worker.taskId);
      if (action === 'resume') await steward.resumeTask(worker.taskId);
      if (action === 'terminate') await steward.cancelTask(worker.taskId);
      sendJson(res, 200, store.getWorker(worker.id));
      return;
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
    if (method === 'POST' && approvalMatch) {
      const body = (await readJson(req)) as { status?: 'approved' | 'rejected' };
      if (body.status !== 'approved' && body.status !== 'rejected') {
        throw new AppError('status 必须是 approved 或 rejected');
      }
      sendJson(res, 200, steward.decideApproval(approvalMatch[1]!, body.status));
      return;
    }

    const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
    if (method === 'GET' && artifactMatch) {
      const artifact = store.getArtifact(artifactMatch[1]!);
      if (!artifact) throw new AppError('产物不存在', 404);
      if (!isWithin(config.artifactsDir, artifact.path)) {
        throw new AppError('产物路径不在允许范围内', 403);
      }
      const content = await readFile(artifact.path, 'utf8');
      sendText(res, 200, content);
      return;
    }

    if (method === 'POST' && pathname === '/api/assistant') {
      const body = (await readJson(req)) as {
        name?: string;
        avatar?: string;
        persona?: string;
        tone?: 'concise' | 'detailed';
        proactivity?: 'ask_first' | 'act_first';
      };
      sendJson(res, 200, steward.updateAssistant(body));
      return;
    }

    throw new AppError('接口不存在', 404);
  }

  function streamEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const write = (event: EventRecord): void => {
      res.write(`id: ${event.id}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
    for (const event of store.listEvents(null, Number.isFinite(after) ? after : 0, 500)) {
      write(event);
    }

    const unsubscribe = bus.subscribe(write);
    const keepalive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  }

  return server;
}
