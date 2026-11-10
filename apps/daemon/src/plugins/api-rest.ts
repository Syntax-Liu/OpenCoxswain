import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptanceDecision,
  Capability,
  ChannelEventKind,
  ChannelInput,
  CreatePlanRequest,
  CreateProjectRequest,
  MemoryCandidate,
  MemoryKind,
  RoleName,
  TaskReplay,
} from '@opencoxswain/shared';
import { CHANNEL_EVENT_KINDS, MEMORY_KINDS, ROLE_NAMES } from '@opencoxswain/shared';
import { capabilityDiff, projectCapabilities } from '@opencoxswain/core';
import type { HttpRouteRequest, PluginContext } from '@opencoxswain/plugin-api';
import { AppError } from '../errors.js';

const TASK_ACTIONS = ['approve', 'reject', 'cancel', 'pause', 'resume', 'retry'] as const;
const WORKER_ACTIONS = ['pause', 'resume', 'terminate'] as const;

/** 能力的人话说明；安装确认页直接展示。 */
const CAPABILITY_NOTES: Record<Capability, string> = {
  'fs.read': '可以读取你的文件',
  'fs.write': '可以修改你的文件',
  'net.read': '可以联网读取资料',
  'net.send': '可以向外部发送消息',
  'proc.spawn': '可以运行本机命令',
  'secrets.use': '可以读取密钥',
};

/** 未指定项目时的默认授权模板：读 + 写 + 联网，外发关闭。 */
const DEFAULT_GRANTED: Capability[] = ['fs.read', 'fs.write', 'proc.spawn', 'net.read'];

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = path.resolve(target).toLowerCase();
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function replayMarkdown(replay: TaskReplay): string {
  const budget = replay.task.contract.budget;
  return [
    `# ${replay.task.title}`,
    '',
    `- 状态：${replay.task.status}`,
    `- 目标：${replay.task.goal}`,
    `- 预算：${JSON.stringify(budget)}`,
    '',
    '## 子任务',
    ...replay.children.map((child) => `- [${child.status}] ${child.title}（${child.contract.assignee?.role ?? '未分配'}）`),
    '',
    '## 员工',
    ...replay.workers.map(
      (worker) =>
        `- ${worker.role} / ${worker.runtime} ${worker.model}：${worker.status}，$${worker.cost.usd.toFixed(4)}`,
    ),
    '',
    '## 审批',
    ...replay.approvals.map((approval) => `- ${approval.type}：${approval.status}`),
    '',
    '## 产物',
    ...replay.artifacts.map((artifact) => `- ${artifact.type} ${artifact.path}`),
    '',
    '## 验收',
    ...replay.acceptance.map(
      (record) =>
        `- [${record.verdict}] ${record.taskId}/${record.criterionId}（${record.judgedBy}${
          record.judgedByUser ? `：${record.judgedByUser}` : ''
        }）${record.note ? `：${record.note}` : ''}`,
    ),
    '',
    '## 证据',
    ...replay.evidence.map(
      (item) =>
        `- ${item.taskId}/${item.criterionId} ${item.kind}（${item.producedBy}）：${item.ref}，摘要 ${item.digest}`,
    ),
    '',
    '## 监察',
    ...replay.supervision.map(
      (action) => `- ${new Date(action.at).toISOString()} ${action.rule} → ${action.verdict}：${action.reason}`,
    ),
    '',
    '## 授权链',
    ...replay.mandates.map(
      (mandate) =>
        `- ${new Date(mandate.issuedAt).toISOString()} ${mandate.taskId}（${mandate.issuedBy}）：能力 ${mandate.capabilities.join('/') || '无'}，根目录 ${mandate.root}，角色 ${mandate.roles.join('/') || '无'}，到期 ${new Date(mandate.expiresAt).toISOString()}`,
    ),
    '',
    '## 副作用台账',
    ...replay.sideEffects.map(
      (effect) =>
        `- ${new Date(effect.createdAt).toISOString()} ${effect.kind} ${effect.target}：${effect.state}${effect.reversible ? '（可补偿）' : '（不可逆）'}`,
    ),
    '',
    '## 事件时间线',
    ...replay.events.map(
      (event) => `- ${new Date(event.createdAt).toISOString()} ${event.type}`,
    ),
    '',
    '## 汇总',
    replay.summary ?? '（无）',
  ].join('\n');
}

function taskIdOf(request: HttpRouteRequest): string {
  const id = request.params.id;
  if (!id) throw new AppError('缺少任务 id');
  return id;
}

const CHANNEL_KINDS = new Set<ChannelEventKind>(CHANNEL_EVENT_KINDS);

/** 通道入参只接受已知字段；密钥与 Webhook 传空串表示清空。 */
function channelPatch(body: unknown): ChannelInput {
  if (typeof body !== 'object' || body === null) throw new AppError('缺少通道配置');
  const raw = body as Record<string, unknown>;
  const patch: ChannelInput = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw new AppError('name 必须是字符串');
    patch.name = raw.name;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') throw new AppError('enabled 必须是布尔值');
    patch.enabled = raw.enabled;
  }
  if (raw.webhookUrl !== undefined) {
    if (typeof raw.webhookUrl !== 'string') throw new AppError('webhookUrl 必须是字符串');
    patch.webhookUrl = raw.webhookUrl;
  }
  if (raw.secret !== undefined) {
    if (typeof raw.secret !== 'string') throw new AppError('secret 必须是字符串');
    patch.secret = raw.secret;
  }
  if (raw.notify !== undefined) {
    if (!Array.isArray(raw.notify) || raw.notify.some((item) => typeof item !== 'string')) {
      throw new AppError('notify 必须是字符串数组');
    }
    patch.notify = (raw.notify as string[]).filter((item): item is ChannelEventKind =>
      CHANNEL_KINDS.has(item as ChannelEventKind),
    );
  }
  return patch;
}

export async function apply(ctx: PluginContext): Promise<void> {
  const http = ctx.service('http');
  const store = ctx.service('storage');
  const steward = ctx.service('steward');
  const scheduler = ctx.service('scheduler');
  const runtimes = ctx.service('runtimes');
  const config = ctx.service('config');
  const secrets = ctx.service('secrets');
  const employees = ctx.service('employees');
  const templates = ctx.service('templates');
  const memory = ctx.service('memory');
  const schedules = ctx.service('schedules');
  const router = ctx.service('router');
  const channels = ctx.service('channels');

  http.route('GET', '/api/employees', async () => ({ json: employees.list() }));

  http.route('GET', '/api/templates', async () => ({ json: templates.list() }));

  http.route('GET', '/api/employees/:id/capabilities', async ({ params, query }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少员工 id');
    const employee = employees.list().find((item) => item.id === id);
    if (!employee) throw new AppError('员工不存在', 404);
    const projectId = query.get('projectId');
    const project = projectId ? store.getProject(projectId) : null;
    if (projectId && !project) throw new AppError('项目不存在', 404);
    const granted = project ? projectCapabilities(project) : DEFAULT_GRANTED;
    const missing = capabilityDiff(employee.capabilities, granted);
    return {
      json: {
        employee,
        declared: employee.capabilities,
        granted,
        missing,
        notes: employee.capabilities.map((capability) => CAPABILITY_NOTES[capability]),
        warnings: missing.map(
          (capability) =>
            `${CAPABILITY_NOTES[capability]}（需要项目额外授权 ${capability}）`,
        ),
      },
    };
  });

  http.route('GET', '/api/memory', async ({ query }) => {
    const projectId = query.get('projectId');
    const keyword = query.get('q')?.trim();
    if (keyword) {
      // scope=all 时跨项目检索（含全局），结果自带 projectId 由前端分组。
      const scopeAll = query.get('scope') === 'all';
      return {
        json: {
          matches: scopeAll
            ? memory.search(keyword, { limit: 20 })
            : memory.recall(keyword, { projectId, limit: 20 }),
        },
      };
    }
    return {
      json: {
        stats: memory.stats(projectId),
        report: memory.report(projectId),
        entries: memory.list(projectId),
      },
    };
  });

  http.route('GET', '/api/memory/check', async ({ query }) => ({
    json: memory.report(query.get('projectId')),
  }));

  http.route('POST', '/api/memory', async ({ body }) => {
    const input = body as Partial<MemoryCandidate>;
    const kind = input.kind;
    if (!kind || !MEMORY_KINDS.includes(kind as MemoryKind)) {
      throw new AppError(`记忆类型非法：${String(kind)}`);
    }
    const result = memory.remember({
      kind: kind as MemoryKind,
      text: typeof input.text === 'string' ? input.text : '',
      source: typeof input.source === 'string' && input.source.trim() ? input.source : 'user:manual',
      projectId: input.projectId ?? null,
      key: input.key ?? null,
    });
    if (result.action === 'rejected') throw new AppError(result.reason);
    return { status: 201, json: result };
  });

  http.route('DELETE', '/api/memory/:id', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少记忆 id');
    if (!memory.remove(id)) throw new AppError('记忆不存在', 404);
    return { json: { ok: true } };
  });

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
        case 'pause':
          return { json: await steward.pauseTask(id) };
        case 'resume':
          return { json: await steward.resumeTask(id) };
        case 'retry':
          return { json: steward.retryTask(id) };
      }
    });
  }

  http.route('POST', '/api/tasks/:id/reassign', async (request) => {
    const body = request.body as { role?: RoleName; note?: string };
    if (!body.role || !ROLE_NAMES.includes(body.role)) throw new AppError('role 非法');
    return { json: await steward.reassignTask(taskIdOf(request), body.role, body.note) };
  });

  http.route('POST', '/api/tasks/:id/acceptance', async (request) => {
    const body = request.body as {
      decisions?: AcceptanceDecision[];
      judgedByUser?: string;
    };
    return {
      json: steward.decideAcceptance(
        taskIdOf(request),
        Array.isArray(body.decisions) ? body.decisions : [],
        body.judgedByUser,
      ),
    };
  });

  http.route('POST', '/api/tasks/:id/viewed', async (request) => ({
    json: steward.markViewed(taskIdOf(request)),
  }));

  http.route('GET', '/api/tasks/:id/brief', async (request) => ({
    json: steward.brief(taskIdOf(request)),
  }));

  http.route('GET', '/api/tasks/:id/delivery', async (request) => ({
    json: await steward.delivery(taskIdOf(request)),
  }));

  http.route('GET', '/api/tasks/:id/diff-review', async (request) => ({
    json: steward.diffReview(taskIdOf(request)),
  }));

  http.route('POST', '/api/tasks/:id/merge', async (request) => {
    const body = request.body as { confirm?: boolean; planHash?: string };
    return {
      json: await steward.mergeDelivery(taskIdOf(request), {
        confirm: body.confirm === true,
        planHash: typeof body.planHash === 'string' ? body.planHash : '',
      }),
    };
  });

  http.route('GET', '/api/review-latency', async (request) => ({
    json: store.reviewLatency(request.query.get('projectId')),
  }));

  http.route('GET', '/api/gate-quality', async (request) => ({
    json: store.gateQuality(request.query.get('projectId')),
  }));

  http.route('GET', '/api/tasks', async (request) => {
    const snapshot = await steward.snapshot(request.query.get('projectId'));
    const kind = request.query.get('stage');
    if (!kind) return { json: { tasks: snapshot.tasks, stages: snapshot.stages } };
    const stages = snapshot.stages.filter((view) => view.stage.kind === kind);
    const ids = new Set(stages.map((view) => view.taskId));
    return { json: { tasks: snapshot.tasks.filter((task) => ids.has(task.id)), stages } };
  });

  http.route('POST', '/api/tasks/:id/inputs', async (request) => {
    const body = request.body as { text?: string };
    const text = body.text?.trim();
    if (!text) throw new AppError('请提供 text');
    return { json: await scheduler.deliverInput(taskIdOf(request), text, 'human') };
  });

  http.route('GET', '/api/tasks/:id/inputs', async (request) => ({
    json: { inputs: store.listTaskInputs(taskIdOf(request)) },
  }));

  http.route('GET', '/api/tasks/:id/summary', async (request) => ({
    json: { summary: steward.summary(taskIdOf(request)) },
  }));

  http.route('GET', '/api/tasks/:id/mandate', async (request) => {
    const taskId = taskIdOf(request);
    if (!store.getTask(taskId)) throw new AppError('任务不存在', 404);
    return {
      json: {
        latest: store.getLatestMandate(taskId),
        mandates: store.listTaskMandates(taskId),
      },
    };
  });

  http.route('GET', '/api/runs/orphaned', async () => ({
    json: { runs: store.listOrphanedRuns() },
  }));

  http.route('GET', '/api/tasks/:id/side-effects', async (request) => {
    const taskId = taskIdOf(request);
    if (!store.getTask(taskId)) throw new AppError('任务不存在', 404);
    return { json: { sideEffects: store.listTaskSideEffects(taskId) } };
  });

  http.route('GET', '/api/side-effects/pending', async () => ({
    json: { sideEffects: store.listPendingSideEffects() },
  }));

  http.route('GET', '/api/tasks/:id/replay', async (request) => {
    const replay = steward.replay(taskIdOf(request));
    if (request.query.get('format') === 'markdown') {
      return { text: replayMarkdown(replay) };
    }
    return { json: replay };
  });

  // 全局路由：只给建议与依据，不建单；是否派活由用户在界面上决定。
  http.route('POST', '/api/route', async ({ body }) => {
    const input = body as { goal?: unknown } | null;
    if (!input || typeof input.goal !== 'string') throw new AppError('缺少目标');
    return { json: { suggestions: router.route(input.goal) } };
  });

  http.route('GET', '/api/schedules', async ({ query }) => ({
    json: { schedules: schedules.list(query.get('projectId')) },
  }));

  http.route('POST', '/api/schedules', async ({ body }) => {
    const input = body as {
      projectId?: string;
      title?: string;
      goal?: string;
      templateId?: string | null;
      intervalMinutes?: number;
      enabled?: boolean;
    };
    if (!input.projectId) throw new AppError('缺少项目 id');
    if (!store.getProject(input.projectId)) throw new AppError('项目不存在', 404);
    if (typeof input.title !== 'string') throw new AppError('缺少定时任务标题');
    if (typeof input.goal !== 'string') throw new AppError('缺少定时任务目标');
    if (typeof input.intervalMinutes !== 'number') throw new AppError('缺少间隔分钟数');
    if (input.templateId && !templates.get(input.templateId)) {
      throw new AppError(`未知任务模板：${input.templateId}`);
    }
    return {
      status: 201,
      json: schedules.create({
        projectId: input.projectId,
        title: input.title,
        goal: input.goal,
        templateId: input.templateId ?? null,
        intervalMinutes: input.intervalMinutes,
        enabled: input.enabled,
      }),
    };
  });

  http.route('POST', '/api/schedules/:id/enabled', async ({ params, body }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少定时任务 id');
    const enabled = (body as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') throw new AppError('enabled 必须是布尔值');
    return { json: schedules.setEnabled(id, enabled) };
  });

  http.route('POST', '/api/schedules/:id/run', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少定时任务 id');
    return { json: await schedules.run(id) };
  });

  http.route('DELETE', '/api/schedules/:id', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少定时任务 id');
    if (!schedules.remove(id)) throw new AppError('定时任务不存在', 404);
    return { json: { ok: true } };
  });

  http.route('GET', '/api/channels', async () => ({ json: { channels: channels.list() } }));

  http.route('POST', '/api/channels', async ({ body }) => ({
    status: 201,
    json: channels.save({ ...channelPatch(body), kind: 'feishu' }),
  }));

  http.route('POST', '/api/channels/:id', async ({ params, body }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少通道 id');
    return { json: channels.save({ ...channelPatch(body), id }) };
  });

  http.route('POST', '/api/channels/:id/test', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少通道 id');
    return { json: await channels.test(id) };
  });

  http.route('DELETE', '/api/channels/:id', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少通道 id');
    if (!channels.remove(id)) throw new AppError('通道不存在', 404);
    return { json: { ok: true } };
  });

  http.route('GET', '/api/projects/:id/costs', async ({ params }) => {
    const id = params.id;
    if (!id) throw new AppError('缺少项目 id');
    if (!store.getProject(id)) throw new AppError('项目不存在', 404);
    return { json: store.projectCostReport(id) };
  });

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
