import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CreatePlanRequest, CreateProjectRequest } from '@opencoxswain/shared';
import type { HttpRouteRequest, PluginContext } from '@opencoxswain/plugin-api';
import { AppError } from '../errors.js';

const TASK_ACTIONS = ['approve', 'reject', 'cancel', 'accept', 'pause', 'resume'] as const;
const WORKER_ACTIONS = ['pause', 'resume', 'terminate'] as const;

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = path.resolve(target).toLowerCase();
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function taskIdOf(request: HttpRouteRequest): string {
  const id = request.params.id;
  if (!id) throw new AppError('缺少任务 id');
  return id;
}

export async function apply(ctx: PluginContext): Promise<void> {
  const http = ctx.service('http');
  const store = ctx.service('storage');
  const steward = ctx.service('steward');
  const runtimes = ctx.service('runtimes');
  const config = ctx.service('config');
  const secrets = ctx.service('secrets');

  http.route('GET', '/api/secrets', async () => {
    const source = await secrets.source('llm_api_key');
    return {
      json: {
        backend: secrets.backend,
        llm: { configured: source !== 'none', source },
      },
    };
  });

  http.route('PUT', '/api/secrets/llm', async ({ body }) => {
    const apiKey = (body as { apiKey?: string }).apiKey?.trim();
    if (!apiKey) throw new AppError('请提供 apiKey');
    await secrets.set('llm_api_key', apiKey);
    return {
      json: { backend: secrets.backend, llm: { configured: true, source: 'vault' } },
    };
  });

  http.route('DELETE', '/api/secrets/llm', async () => {
    await secrets.remove('llm_api_key');
    const source = await secrets.source('llm_api_key');
    return {
      json: {
        backend: secrets.backend,
        llm: { configured: source !== 'none', source },
      },
    };
  });

  http.route('GET', '/api/health', async () => {
    const status = await runtimes.health();
    return {
      json: {
        ok: status.ok,
        version: config.version,
        adapter: status.adapter,
        detail: status.detail,
      },
    };
  });

  http.route('GET', '/api/bootstrap', async ({ query }) => ({
    json: await steward.snapshot(query.get('projectId')),
  }));

  http.route('POST', '/api/projects', async ({ body }) => ({
    status: 201,
    json: await steward.createProject(body as CreateProjectRequest),
  }));

  http.route('POST', '/api/projects/:id/plan', async ({ params, body }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少项目 id');
    return { json: await steward.createPlan(id, body as CreatePlanRequest) };
  });

  http.route('POST', '/api/projects/:id/settings', async ({ params, body }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少项目 id');
    const patch = body as { dailyBudgetUsd?: number; maxConcurrency?: number };
    return { json: steward.updateProjectSettings(id, patch) };
  });

  for (const action of TASK_ACTIONS) {
    http.route('POST', `/api/tasks/:id/${action}`, async (request) => {
      const id = taskIdOf(request);
      const body = request.body as { note?: string };
      switch (action) {
        case 'approve':
          return { json: steward.approveTask(id) };
        case 'reject':
          return { json: steward.rejectTask(id, body.note) };
        case 'cancel':
          return { json: await steward.cancelTask(id) };
        case 'accept':
          return { json: steward.acceptTask(id) };
        case 'pause':
          return { json: await steward.pauseTask(id) };
        case 'resume':
          return { json: await steward.resumeTask(id) };
      }
    });
  }

  http.route('GET', '/api/tasks/:id/summary', async (request) => ({
    json: { summary: steward.summary(taskIdOf(request)) },
  }));

  http.route('GET', '/api/tasks/:id/replay', async (request) => ({
    json: steward.replay(taskIdOf(request)),
  }));

  for (const action of WORKER_ACTIONS) {
    http.route('POST', `/api/workers/:id/${action}`, async ({ params }) => {
      const id = params.id;
      if (!id) throw new AppError('缺少员工 id');
      const worker = store.getWorker(id);
      if (!worker) throw new AppError('员工不存在', 404);
      if (action === 'pause') await steward.pauseTask(worker.taskId);
      if (action === 'resume') await steward.resumeTask(worker.taskId);
      if (action === 'terminate') await steward.cancelTask(worker.taskId);
      return { json: store.getWorker(worker.id) };
    });
  }

  http.route('POST', '/api/approvals/:id/decide', async ({ params, body }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少审批 id');
    const status = (body as { status?: 'approved' | 'rejected' }).status;
    if (status !== 'approved' && status !== 'rejected') {
      throw new AppError('status 必须是 approved 或 rejected');
    }
    return { json: steward.decideApproval(id, status) };
  });

  http.route('GET', '/api/artifacts/:id', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少产物 id');
    const artifact = store.getArtifact(id);
    if (!artifact) throw new AppError('产物不存在', 404);
    if (!isWithin(config.artifactsDir, artifact.path)) {
      throw new AppError('产物路径不在允许范围内', 403);
    }
    return { text: await readFile(artifact.path, 'utf8') };
  });

  http.route('POST', '/api/assistant', async ({ body }) => ({
    json: steward.updateAssistant(
      body as {
        name?: string;
        avatar?: string;
        persona?: string;
        tone?: 'concise' | 'detailed';
        proactivity?: 'ask_first' | 'act_first';
      },
    ),
  }));
}
