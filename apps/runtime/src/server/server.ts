/**
 * HTTP / SSE 服务层。
 *
 * 把 `Orchestrator` 暴露成一组 REST + SSE 接口，供桌面壳与未来的 IM 通道使用。
 *
 * 设计取舍：
 * 1. **只用 Node 内置 `http`**，不引入 Express/Fastify —— 自研意味着依赖面要小。
 * 2. **默认只监听 127.0.0.1**。这是本地优先的产品，不对外暴露。
 * 3. **SSE 支持断线重放**（见 `bus.ts`），避免界面显示过期状态。
 * 4. **所有写操作都返回可读错误**（400/404 + `{ error }`），不甩堆栈给用户。
 *
 * 接口一览：
 *
 * | 方法 | 路径 | 作用 |
 * | --- | --- | --- |
 * | GET  | `/api/health` | 健康检查 |
 * | GET  | `/api/projects` | 项目列表 |
 * | POST | `/api/projects` | 打开/新建项目 |
 * | GET  | `/api/projects/:id` | 项目详情（含Agent与汇报） |
 * | GET  | `/api/projects/:id/messages` | Assistant 的对话历史 |
 * | POST | `/api/projects/:id/say` | 对 Assistant 说一句话（立刻返回） |
 * | POST | `/api/projects/:id/stop` | 停止 C 当前这一轮 |
 * | GET  | `/api/projects/:id/reports` | 汇报列表 |
 * | GET  | `/api/executors/:id` | Agent详情 |
 * | POST | `/api/executors/:id/cancel` | 取消Agent |
 * | GET  | `/api/executors/:id/messages` | "打开原会话"：Agent 的完整记录 |
 * | POST | `/api/route` | Supervisor 的路由判断 |
 * | POST | `/api/handoff` | B 转交原话 |
 * | GET  | `/api/events` | SSE 事件流（支持 `?after=`） |
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Orchestrator, RuntimeEvent } from '../orchestrator.js';
import { findProject, handoff, projectBrief } from '../global/assistant.js';
import { isInternalSource, type Store } from '../store/store.js';
import { approveAction, rejectAction } from '../security/approval.js';
import type { ImSettingsStore } from '../im/settings.js';
import type { ImBridge } from '../im/bridge.js';
import { TelegramClient } from '../im/telegram.js';
import { readUpdateCheck } from '../update/check.js';
import { isAllowedOrigin, isAuthorized } from './token.js';
import type { ScheduleSpec } from '../schedules/schedules.js';
import { validateSettings, type ModelConfig, type ModelSettings } from '../llm/models.js';
import {
  LEVEL_HINT,
  LEVEL_LABEL,
  PERMISSION_LEVELS,
  parseLevel,
} from '../settings/permission.js';
import { parseTokenGuard, startOfToday } from '../cost/budget.js';
import { aggregate } from '../cost/metrics.js';
import { EventBus } from './bus.js';
import type { ContentPart } from '../llm/types.js';

export interface ServerOptions {
  readonly orchestrator: Orchestrator;
  readonly store: Store;
  readonly host?: string;
  readonly port?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** IM 通道配置。提供后暴露 `/api/im`。 */
  readonly imSettings?: ImSettingsStore;
  /** 已构造好的 IM 桥接（未配置 token 时为 null）。 */
  readonly im?: ImBridge | null;
  /**
   * 静态资源目录（工作台构建产物）。
   *
   * 提供后，同一个端口既服务 `/api/*` 又服务界面文件：
   * 桌面壳只需加载 `http://127.0.0.1:<port>/`，**没有跨源问题，
   * 也不需要额外起一个静态服务器**。
   */
  readonly staticDir?: string;
  /**
   * 本机访问令牌。所有 `/api/*` 请求（健康检查除外）都必须带
   * `Authorization: Bearer <token>`。
   *
   * **不传 = 不校验**，仅限测试与显式关闭。
   * 生产启动由 `cli.ts` 生成并传入；`cli.ts` 里禁止省略。
   */
  readonly token?: string;
  /**
   * 模型密钥配置。提供后暴露 `/api/settings`：
   * 界面靠它显示"是否已配置"，并在用户填写后**立即生效**（不需要重启）。
   */
  readonly llmSettings?: {
    status(): Promise<{ configured: boolean; source: 'env' | 'file' | 'none'; baseUrl: string; model: string }>;
    save(settings: { apiKey: string; baseUrl: string; model: string }): Promise<void>;
    clear(): Promise<void>;
    /** 保存/清除后让内存里的客户端重新解析配置。 */
    refresh(): Promise<boolean>;
  };
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const CORS_METHODS = 'GET,POST,DELETE,OPTIONS';
const CORS_HEADERS = 'Content-Type,Last-Event-ID,Authorization';

/**
 * 按请求来源生成 CORS 头。
 *
 * **不再用 `*`**：之前任意网页都能跨源读这个 API，
 * 而 API 能派活、能跑命令。现在只回显本地界面自己的来源。
 */
function corsHeaders(origin: string | undefined, selfPorts: readonly number[]): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    Vary: 'Origin',
  };
  if (origin && isAllowedOrigin(origin, selfPorts)) {
    base['Access-Control-Allow-Origin'] = origin;
  }
  // 不在白名单时不带 Allow-Origin：浏览器会拦下响应。
  return base;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { orchestrator, store } = options;
  const im = options.im ?? null;
  const imSettings = options.imSettings ?? null;
  const bus = new EventBus();
  const log = options.log ?? (() => {});
  const openStreams = new Set<() => void>();
  const staticDir = options.staticDir;
  const llmSettings = options.llmSettings;
  /** 本机访问令牌：API 请求必须带它。 */
  const token = options.token ?? '';
  /**
   * 实际监听端口（用于判断 Origin 是否是自己）。
   *
   * 监听成功后会被修正为真实端口：`port: 0` 时由系统分配，
   * 沿用配置值会把我们自己的来源也拒掉。
   */
  let selfPort = options.port ?? 47900;

  // 把运行时事件转进总线。
  orchestrator.on('runtime', (event: RuntimeEvent) => bus.publish(event));

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      fail(res, 500, error instanceof Error ? error.message : String(error));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const cors = corsHeaders(origin, [selfPort]);
    // 本请求的响应助手：自动带上 CORS 头，避免 45 处调用各写一遍还漏掉。
    const reply = (status: number, body: unknown): void => json(res, status, body, cors);
    const deny = (status: number, error: string): void => fail(res, status, error, cors);

    if (method === 'OPTIONS') {
      // 预检：来源不在白名单时**不带 Allow-Origin**，浏览器会阻止真正的请求。
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const isApi = url.pathname.startsWith('/api/');
    // 首屏与静态资源不需要令牌：否则界面本身都加载不了。
    // 令牌通过首屏注入递给前端（见 serveIndex）。
    //
    // `token === ''` 表示**不校验**：只用于测试与显式关闭。
    // 生产启动一定会传令牌（cli.ts 里 resolve 出来）。
    if (isApi && token !== '' && url.pathname !== '/api/health') {
      if (typeof req.headers.origin === 'string' && !isAllowedOrigin(origin, [selfPort])) {
        return deny(403, '来源不被允许');
      }
      if (!isAuthorized(req.headers.authorization, token)) {
        return deny(401, '缺少或错误的访问令牌');
      }
    }

    // ---- 健康检查 ----
    // ---- 设置：模型密钥 ----
    if (url.pathname === '/api/settings') {
      if (!llmSettings) return deny(404, '本服务未启用设置接口');
      if (method === 'GET') {
        return reply(200, await llmSettings.status());
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const apiKey = str(body.apiKey);
        if (!apiKey) return deny(400, '缺少 apiKey');
        await llmSettings.save({
          apiKey,
          baseUrl: str(body.baseUrl) ?? '',
          model: str(body.model) ?? '',
        });
        await llmSettings.refresh();
        return reply(200, { ok: true, ...(await llmSettings.status()) });
      }
      if (method === 'DELETE') {
        await llmSettings.clear();
        await llmSettings.refresh();
        return reply(200, { ok: true, ...(await llmSettings.status()) });
      }
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      return reply(200, { ok: true, stats: orchestrator.stats(), lastSeq: bus.lastSeq });
    }

    // ---- SSE ----
    if (method === 'GET' && url.pathname === '/api/events') {
      const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
      return stream(res, Number.isFinite(after) ? after : 0, cors);
    }

    // ---- 记忆候选：采纳 / 忽略 ----
    const memMatch = /^\/api\/memories\/([^/]+)\/(accept|dismiss)$/.exec(url.pathname);
    if (method === 'POST' && memMatch) {
      const candidateId = decodeURIComponent(memMatch[1]!);
      const act = memMatch[2];
      const result =
        act === 'accept'
          ? await orchestrator.acceptMemoryCandidate(candidateId)
          : await orchestrator.dismissMemoryCandidate(candidateId);
      return result.ok ? json(res, 200, result) : fail(res, 400, result.message);
    }

    // ---- 删除一条已生效的记忆 ----
    // 路径形如 /api/projects/:id/memory/:scope/:entryId/forget
    const forgetMatch = /^\/api\/projects\/([^/]+)\/memory\/(global|project)\/([^/]+)\/forget$/.exec(
      url.pathname,
    );
    if (method === 'POST' && forgetMatch) {
      const result = await orchestrator.forgetMemory(
        decodeURIComponent(forgetMatch[1]!),
        forgetMatch[2] as 'global' | 'project',
        decodeURIComponent(forgetMatch[3]!),
      );
      return result.ok ? json(res, 200, result) : fail(res, 400, result.message);
    }

    // ---- 更新状态 ----
    // 壳负责真正去查（它有 Tauri 的更新插件），结果落在文件里，这里读出来给界面。
    if (method === 'GET' && url.pathname === '/api/update') {
      const check = await readUpdateCheck();
      return reply(200, {
        // 没查过时是 null：界面显示"未检查"，不是错误。
        check,
        currentVersion: process.env.OPENCOXSWAIN_VERSION ?? null,
      });
    }

    // ---- IM 通道（Telegram）----
    if (url.pathname === '/api/im') {
      if (!imSettings) return deny(404, 'IM 通道未启用');

      if (method === 'GET') {
        const config = await imSettings.resolve();
        return reply(200, {
          enabled: config.botToken !== '',
          // **绝不回传 token 本身**，只告诉界面有没有配。
          hasToken: config.botToken !== '',
          chatIds: config.chatIds,
          projectId: config.projectId,
          status: im?.status() ?? null,
        });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const token = str(body.botToken);
        const projectId = str(body.projectId);

        if (token) {
          // 先验证 token，避免存进去一个错的、之后一头雾水。
          try {
            await new TelegramClient(token).getMe();
          } catch (error) {
            return fail(
              res,
              400,
              `token 无效：${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        await imSettings.save({
          botToken: (token ?? '').trim(),
          chatIds: (await imSettings.read()).chatIds,
          projectId: (projectId ?? '').trim() || null,
        });
        return reply(200, { ok: true });
      }
      if (method === 'DELETE') {
        await imSettings.clear();
        await im?.stop();
        return reply(200, { ok: true });
      }
    }

    // ---- 启动/停止通道 ----
    if (method === 'POST' && url.pathname === '/api/im/start') {
      if (!im) return deny(400, 'IM 通道未启用');
      im.start();
      return reply(200, { ok: true, status: im.status() });
    }
    if (method === 'POST' && url.pathname === '/api/im/stop') {
      await im?.stop();
      return reply(200, { ok: true });
    }

    // ---- 多模型配置 ----
    if (url.pathname === '/api/models') {
      if (method === 'GET') {
        return reply(200, {
          settings: await orchestrator.modelSettings(),
          storage: orchestrator.modelStorageMode(),
        });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const settings = {
          models: Array.isArray(body.models) ? (body.models as ModelConfig[]) : [],
          roles: (body.roles ?? { supervisor: null, assistant: null, agent: null }) as ModelSettings['roles'],
        };
        // 配置错误要明确告诉用户，不能静默保存
        const errors = validateSettings(settings);
        if (errors.length > 0) {
          return deny(400, errors.join('；'));
        }
        await orchestrator.saveModelSettings(settings);
        return reply(200, { ok: true, storage: orchestrator.modelStorageMode() });
      }
    }

    // ---- 权限档位 ----
    if (url.pathname === '/api/permissions') {
      if (method === 'GET') {
        const settings = await orchestrator.permissionSettings();
        return reply(200, {
          settings,
          levels: PERMISSION_LEVELS.map((id) => ({
            id,
            label: LEVEL_LABEL[id],
            hint: LEVEL_HINT[id],
          })),
        });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const level = parseLevel(body.level);
        await orchestrator.setPermissionLevel(level);
        return reply(200, { ok: true, settings: { level } });
      }
    }

    // ---- 关闭行为设置 ----
    if (url.pathname === '/api/close-settings') {
      if (method === 'GET') {
        return reply(200, {
          settings: await orchestrator.closeSettings(),
          running: orchestrator.runningAgents(),
        });
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const action = body.closeAction === 'quit' ? 'quit' : 'tray';
        await orchestrator.setCloseSettings({ closeAction: action });
        return reply(200, { ok: true, settings: { closeAction: action } });
      }
    }

    // 关闭前检查：选「退出」且有 Agent 在跑时，要提示用户。
    if (method === 'GET' && url.pathname === '/api/close-check') {
      return reply(200, await orchestrator.checkClose());
    }

    // ---- Supervisor：跨项目视图与优先级 ----
    if (method === 'GET' && url.pathname === '/api/global') {
      return reply(200, {
        overview: orchestrator.globalOverview(),
        priorities: orchestrator.priorities(),
        summary: orchestrator.describeGlobal(),
      });
    }

    // ---- 任务模板 ----
    if (method === 'GET' && url.pathname === '/api/templates') {
      return reply(200, { templates: orchestrator.listTemplates() });
    }

    // ---- 套用模板：只生成草稿，**不派活** ----
    const applyMatch = /^\/api\/templates\/([^/]+)\/apply$/.exec(url.pathname);
    if (method === 'POST' && applyMatch) {
      const templateId = decodeURIComponent(applyMatch[1]!);
      const body = await readJson(req);
      try {
        const applied = orchestrator.applyTemplate(templateId, {
          label: str(body.label) ?? '',
          goal: str(body.goal) ?? '',
        });
        return reply(200, applied);
      } catch (error) {
        return deny(400, error instanceof Error ? error.message : String(error));
      }
    }

    // ---- 定时建议 ----
    if (method === 'GET' && url.pathname === '/api/schedules') {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      return reply(200, { schedules: await orchestrator.listSchedules(projectId) });
    }
    if (method === 'POST' && url.pathname === '/api/schedules') {
      const body = await readJson(req);
      const spec = body as unknown as ScheduleSpec;
      if (!spec?.id || !spec?.projectId || !spec.title || !spec.goal) {
        return deny(400, '定时任务缺少必要字段（id / projectId / title / goal）');
      }
      await orchestrator.saveSchedule(spec);
      return reply(200, { ok: true });
    }

    // 手动触发一次检查：返回建议，**仍然不派活**。
    if (method === 'POST' && url.pathname === '/api/schedules/check') {
      const fired = await orchestrator.checkSchedules();
      return reply(200, {
        suggestions: fired,
        note: '这只是提醒，还没有派活。确认后才会开始。',
      });
    }

    // ---- 危险动作审批 ----
    if (method === 'GET' && url.pathname === '/api/approvals') {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      return reply(200, {
        approvals: store.listApprovals({
          ...(projectId ? { projectId } : {}),
        }),
      });
    }

    const approvalMatch = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
    if (method === 'POST' && approvalMatch) {
      const approvalId = decodeURIComponent(approvalMatch[1]!);
      const action = approvalMatch[2];
      const body: Record<string, unknown> = await readJson(req).catch(() => ({}));
      const reason = str(body.reason);
      const result =
        action === 'approve'
          ? await approveAction(store, approvalId, reason)
          : await rejectAction(store, approvalId, reason);
      return result.ok ? json(res, 200, result) : fail(res, 400, result.message);
    }

    // ---- 项目 ----
    if (method === 'GET' && url.pathname === '/api/projects') {
      return reply(200, {
        projects: store.listProjects().map((p) => ({
          ...p,
          running: store
            .listExecutors({ projectId: p.id, status: ['running', 'starting'] })
            .length,
          needsUser: store.listReports({ projectId: p.id, needsUser: true }).length,
        })),
        lastSeq: bus.lastSeq,
      });
    }

    if (method === 'POST' && url.pathname === '/api/projects') {
      const body = await readJson(req);
      const rootPath = str(body.rootPath);
      if (!rootPath) return deny(400, '缺少 rootPath（项目的绝对路径）');
      const opened = await orchestrator.openProject({
        rootPath,
        ...(str(body.name) ? { name: str(body.name)! } : {}),
      });
      return reply(200, { project: opened.project, lastSeq: bus.lastSeq });
    }

    const projectMatch = /^\/api\/projects\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
    if (projectMatch) {
      const projectId = decodeURIComponent(projectMatch[1]!);
      const action = projectMatch[2];
      const project = store.getProject(projectId);
      if (!project) return deny(404, `项目 ${projectId} 不存在`);

      if (method === 'GET' && !action) {
        return reply(200, {
          project,
          executors: store.listExecutors({ projectId }),
          reports: store.listReports({ projectId }),
          lastSeq: bus.lastSeq,
        });
      }

      if (method === 'GET' && action === 'messages') {
        return reply(200, {
          messages: store.messages(project.assistantSessionId).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            source: m.source,
            at: m.at,
            // 内部通知（Agent结算等）不进对话流。
            internal: isInternalSource(m.source),
            // 图片附件：刷新后历史里要能看到缩略图。
            // 不返回的话，用户重开界面就看不到自己发过的图了。
            ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
          })),
          lastSeq: bus.lastSeq,
        });
      }

      if (method === 'POST' && action === 'say') {
        const body = await readJson(req);
        const text = str(body.text) ?? '';

        // 图片附件：每项是 { type:'image', dataUrl, name }
        const rawImages = Array.isArray(body.images) ? body.images : [];
        const images: ContentPart[] = [];
        for (const item of rawImages) {
          const record = item as { dataUrl?: unknown; name?: unknown };
          if (typeof record?.dataUrl !== 'string') continue;
          // **只接受 data:image/**：不接受任意 URL，避免把"让服务端去抓某个
          // 网址"变成一条攻击路径（SSRF）。
          // 显式拒绝而不是静默跳过——静默跳过会让用户以为图发出去了。
          if (!record.dataUrl.startsWith('data:image/')) {
            return deny(400, '图片必须是 data:image/ 开头的内联数据，不接受外部 URL');
          }
          images.push({
            type: 'image',
            dataUrl: record.dataUrl,
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
          });
        }

        // **允许只发图片不发文字**——拖一张截图就发是很自然的动作。
        // 但没有文字也没有图片才是真的空请求。
        if (!text && images.length === 0) return deny(400, '缺少 text，也没有图片');

        // 立刻返回：Assistant 的回复通过 SSE 推送，不在这里等。
        await orchestrator.userSays(projectId, text, {
          source: str(body.source) ?? 'webapp',
          ...(images.length > 0 ? { images } : {}),
        });
        return reply(202, { accepted: true, lastSeq: bus.lastSeq });
      }

      if (method === 'POST' && action === 'stop') {
        const assistant = orchestrator.getAssistant(projectId);
        if (!assistant) return deny(404, '该项目的Assistant当前未加载');
        assistant.stop();
        return reply(200, { stopped: true });
      }

      if (method === 'GET' && action === 'reports') {
        return reply(200, { reports: store.listReports({ projectId }) });
      }

      // 用量统计（不做计费，只呈现真实 token 数字）
      if (method === 'GET' && action === 'usage') {
        const today = store.costSince(projectId, startOfToday());
        const all = store.costSince(projectId, 0);
        const rows = store.listExecutors({ projectId });
        const totals = aggregate(rows.map((r) => r.metrics));
        return reply(200, {
          guard: project.tokenGuard ?? null,
          today,
          all,
          totals,
          todayRuns: rows.filter((r) => r.createdAt >= startOfToday()).length,
        });
      }

      // 记忆候选：GET 查看，POST 触发一次提炼
      if (action === 'memories') {        if (method === 'GET') {
          return reply(200, {
            candidates: store.listCandidates({ projectId }),
            pending: store.listCandidates({ projectId, status: ['pending'] }).length,
          });
        }
        if (method === 'POST') {
          const result = await orchestrator.extractMemoryCandidates(projectId);
          return reply(200, {
            ...result,
            candidates: store.listCandidates({ projectId, status: ['pending'] }),
          });
        }
      }

      // 已生效的记忆（全局 + 项目），可查看与删除
      if (action === 'memory-list') {
        return reply(200, await orchestrator.listMemories(projectId));
      }

      // 设置用量止损上限（不是计费）
      if (method === 'POST' && action === 'guard') {        const body = await readJson(req);
        let guard;
        try {
          guard = parseTokenGuard(body);
        } catch (error) {
          return deny(400, error instanceof Error ? error.message : '用量上限格式不正确');
        }
        await store.putProject({
          ...project,
          tokenGuard: guard,
          updatedAt: Date.now(),
        });
        return reply(200, { ok: true, guard });
      }
    }

    // ---- Agent ----
    const execMatch = /^\/api\/executors\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
    if (execMatch) {
      const executorId = decodeURIComponent(execMatch[1]!);
      const action = execMatch[2];
      const executor = store.getExecutor(executorId);
      if (!executor) return deny(404, `Agent ${executorId} 不存在`);

      if (method === 'GET' && !action) {
        return reply(200, { executor, lastSeq: bus.lastSeq });
      }

      if (method === 'GET' && action === 'messages') {
        // "打开原会话"：Agent 的完整轨迹（含每次工具调用）。
        const transcript = orchestrator.executorTranscript(executorId);
        return reply(200, {
          executor: executor,
          session: store.getSession(executor.sessionId) ?? null,
          messages: transcript.messages,
          lastSeq: bus.lastSeq,
        });
      }

      if (method === 'POST' && action === 'say') {
        // 用户直接对 Agent 说一句（带原上下文续跑）。
        const body = await readJson(req);
        const text = str(body.text);
        if (!text) return deny(400, '缺少 text');
        const result = await orchestrator.userSaysToExecutor(executorId, text);
        return result.ok ? json(res, 200, result) : fail(res, 400, result.message);
      }

      if (method === 'POST' && action === 'cancel') {
        const result = await orchestrator.cancel(executorId);
        return result.ok ? json(res, 200, result) : fail(res, 400, result.content);
      }

      // 删除会话（Agent 及其会话与消息）。正在跑的会被拒绝。
      if (method === 'DELETE' && !action) {
        try {
          await orchestrator.deleteExecutor(executorId);
          return json(res, 200, { ok: true });
        } catch (error) {
          return fail(res, 400, error instanceof Error ? error.message : String(error));
        }
      }

      // "它到底改了什么"：这个 Agent的完整副作用台账。
      if (method === 'GET' && action === 'effects') {
        return reply(200, {
          effects: store.listSideEffects({ executorId }),
        });
      }
    }

    // ---- Supervisor 的路由 ----
    if (method === 'POST' && url.pathname === '/api/route') {
      const body = await readJson(req);
      const query = str(body.query);
      if (!query) return deny(400, '缺少 query');
      const decision = findProject(store, query, {
        ...(str(body.currentProjectId)
          ? { currentProjectId: str(body.currentProjectId)! }
          : {}),
      });
      return reply(200, decision);
    }

    if (method === 'GET' && url.pathname === '/api/route/brief') {
      return reply(200, { projects: projectBrief(store) });
    }

    if (method === 'POST' && url.pathname === '/api/handoff') {
      const body = await readJson(req);
      const projectId = str(body.projectId);
      const userText = str(body.userText);
      if (!projectId) return deny(400, '缺少 projectId');
      if (!userText) return deny(400, '缺少 userText（用户原话）');
      const result = await handoff(orchestrator, store, { projectId, userText });
      return result.ok ? json(res, 200, result) : fail(res, 400, result.reason);
    }

    // 静态资源兜底：桌面壳直接加载 http://127.0.0.1:<port>/ 即可，
    // 界面与 API 同源，没有跨源问题。
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      if (await serveStatic(req, res, url.pathname)) return;
    }

    return deny(404, `未知接口：${method} ${url.pathname}`);
  }

  function contentTypeOf(file: string): string {
    switch (path.extname(file).toLowerCase()) {
      case '.html':
        return 'text/html; charset=utf-8';
      case '.js':
      case '.mjs':
        return 'text/javascript; charset=utf-8';
      case '.css':
        return 'text/css; charset=utf-8';
      case '.json':
        return 'application/json; charset=utf-8';
      case '.svg':
        return 'image/svg+xml';
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.ico':
        return 'image/x-icon';
      case '.woff2':
        return 'font/woff2';
      case '.map':
        return 'application/json; charset=utf-8';
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * 提供静态文件（工作台）。
   *
   * 安全要点：只允许落在 `staticDir` 内部的路径，防路径穿越。
   * 找不到文件时回落到 `index.html`（单页应用的路由行为）。
   */
  async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (!staticDir) return false;
    const root = path.resolve(staticDir);

    // 路径穿越防护：解析后必须仍在 root 内。
    const requested = pathname === '/' ? '/index.html' : pathname;
    let target = path.resolve(root, `.${requested}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      fail(res, 403, '非法路径');
      return true;
    }

    let data: Buffer;
    try {
      data = await readFile(target);
    } catch {
      // 单页应用回落：不是 /api 的未知路径都交给前端路由。
      try {
        data = await readFile(path.join(root, 'index.html'));
        target = path.join(root, 'index.html');
      } catch {
        return false;
      }
    }

    const tag = etagOf(data);
    // 协商缓存：客户端带回同一个 ETag 就直接 304，省掉重复传输。
    if (req.headers['if-none-match'] === tag) {
      res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }

    // 首屏注入访问令牌：界面必须能拿到它才能调 API。
    // 这是令牌的唯一出口——**只注入到 index.html**，不进 JS 资源文件，
    // 也不通过 API 回传。
    if (target.endsWith('index.html')) {
      const injected = injectToken(data.toString('utf8'), token);
      const body = Buffer.from(injected, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        // 首页绝不能缓存：里面的令牌可能随重启变化。
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return true;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeOf(target),
      'Content-Length': data.length,
      // 缓存策略：**只用 no-cache + ETag**，不用长缓存。
      //
      // 教训：之前给 assets 设 `immutable`（一年），结果桌面应用升级后
      // webview 仍然加载旧 JS，界面上看到的还是修复前的样子，
      // 排查半天以为是渲染逻辑没生效。本地应用的静态资源没必要强缓存。
      // 带 ETag 的协商缓存既保证拿到最新文件，又能避免重复传输。
      'Cache-Control': 'no-cache',
      ETag: tag,
    });
    res.end(data);
    return true;
  }

  function stream(res: ServerResponse, after: number, cors: Record<string, string>): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...cors,
    });
    // 立刻把响应头与一条注释冲刷出去。
    // 不这么做，客户端 fetch() 会一直等到第一个数据块或超时（实测约 15s），
    // 表现为"连上了但迟迟收不到事件"。
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const write = (item: { seq: number; at: number; event: unknown }): void => {
      res.write(`id: ${item.seq}\n`);
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    };

    // 先补发再订阅（bus.subscribe 内部保证顺序正确）。
    const unsubscribe = bus.subscribe(write, after);

    // 心跳：防止代理/浏览器把空闲连接掐断。
    const keepalive = setInterval(() => {
      res.write(': ping\n\n');
    }, 15_000);
    (keepalive as { unref?: () => void }).unref?.();

    const cleanup = (): void => {
      clearInterval(keepalive);
      unsubscribe();
      openStreams.delete(cleanup);
      if (!res.writableEnded) res.end();
    };
    openStreams.add(cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 47900;

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: NodeJS.ErrnoException): void => {
      // 端口被占用是最常见的情况：多半是已经开了一个实例。
      // 原始错误 `listen EADDRINUSE 127.0.0.1:47900` 对用户毫无意义，
      // 这里换成能照着做的说明。
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用。\n` +
              `通常是因为已经开了一个 OpenCoxswain。\n` +
              `请先关掉那个窗口；若确认没有在运行，可能是别的程序占用了 ${port} 端口，\n` +
              `可以用 \`netstat -ano | findstr ${port}\` 查看是谁，` +
              `或设置环境变量 OPENCOXSWAIN_PORT 换一个端口。`,
          ),
        );
        return;
      }
      if (error.code === 'EACCES') {
        reject(new Error(`没有权限监听端口 ${port}。请换一个大于 1024 的端口。`));
        return;
      }
      reject(error);
    };

    server.once('error', onListenError);
    server.listen(port, host, () => {
      // 启动成功后换成持久监听，避免之后 socket 出错时无人处理而崩掉进程。
      server.removeListener('error', onListenError);
      server.on('error', (error) => log('error', `服务出错：${error.message}`));
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  // 用真实端口判断 Origin：port: 0 时实际端口与配置值不同。
  selfPort = actualPort;
  log('info', `HTTP/SSE 服务已启动：http://${host}:${actualPort}`);

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    async close() {
      for (const cleanup of [...openStreams]) cleanup();
      openStreams.clear();
      orchestrator.off('runtime', bus.publish);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  cors: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...cors,
  });
  res.end(payload);
}

function fail(
  res: ServerResponse,
  status: number,
  error: string,
  cors: Record<string, string> = {},
): void {
  json(res, status, { error }, cors);
}

/**
 * 把访问令牌注入首屏。
 *
 * 前端从 `window.__OCX_TOKEN__` 读它，随每个 API 请求发出。
 *
 * 安全性说明：这个令牌只对**能加载这个页面的人**可见，
 * 也就是本机上打开界面的人——这正是我们要保证的范围。
 * 恶意网页因为跨源限制拿不到这个页面的内容。
 */
export function injectToken(html: string, token: string): string {
  // 不能只靠 JSON.stringify：
  // 1. 令牌里若含 `</script>` 会直接闭合脚本标签（XSS）；
  // 2. U+2028 / U+2029 在旧 JS 引擎里是非法换行符。
  // 当前令牌是 base64url 不会遇到，但注入函数不该假设这一点。
  const safe = JSON.stringify(token)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  // 窗口控制令牌：桌面壳注入到运行时的环境变量，界面用它调窗口控制接口。
  // 普通浏览器里没有这个变量，前端据此判断"不是桌面环境"。
  const controlRaw = process.env.OPENCOXSWAIN_SECRET_TOKEN ?? '';
  const control = controlRaw ? JSON.stringify(controlRaw).replace(/</g, '\\u003c') : 'null';

  const script = `<script>window.__OCX_TOKEN__=${safe};window.__OCX_SECRET_TOKEN__=${control};</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${script}${html.slice(at)}`;
  }
  return `${script}${html}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // 防超大 body 打爆内存。
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大（上限 4MB）');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 内容指纹作为 ETag。
 *
 * 用内容哈希而不是 mtime：打包时文件的 mtime 可能被复制操作刷新，
 * 内容哈希才真正反映"文件变了没有"。
 */
function etagOf(data: Buffer): string {
  return `"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`;
}
