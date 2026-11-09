import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptanceDecision,
  Capability,
  CreatePlanRequest,
  CreateProjectRequest,
  RoleName,
  TaskReplay,
} from '@opencoxswain/shared';
import { ROLE_NAMES } from '@opencoxswain/shared';
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

export async function apply(ctx: PluginContext): Promise<void> {
  const http = ctx.service('http');
  const store = ctx.service('storage');
  const steward = ctx.service('steward');
  const scheduler = ctx.service('scheduler');
  const runtimes = ctx.service('runtimes');
  const config = ctx.service('config');
  const secrets = ctx.service('secrets');
  const employees = ctx.service('employees');

  http.route('GET', '/api/employees', async () => ({ json: employees.list() }));

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
