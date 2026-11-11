/**
 * C 的生命周期：常驻根 Agent。
 *
 * 这是整个重构的核心。旧 `orchestrator/runner.ts` 把"项目助理"实现成
 * 一次性子代理（`startActivation` 派活、结算即结束），正是
 * docs/README.md 点名的偏差所在。
 *
 * 正确形态（P0-T1 已证实）：
 * - 用 `ctx.agents.create({ sessionId, meta:{ cwd, agentPreset } })` **不传 parentAgent**
 *   → 得到根 Agent；
 * - 插件持有 `AgentHandle`，可随时 `ctx.agents.get(cId)` 取回再 `followup`；
 * - 重启后用 `ctx.agents.resume({ resumeSessionId })` 恢复（D5 完整恢复）。
 *
 * 硬限制 L2：C 不属于任何父树，没有"父树统一 dispose"。插件必须在
 * `ctx.effect` 里逐个 dispose 自己持有的 handle。
 */
import type { ResolvedConfig } from '../config.js';
import type { ProjectRow } from '../domain.js';
import type { AgentRegistryLike, AgentHandleLike, HostApi } from '../host.js';
import type { Agent } from '../host-types.js';
import { newId, nowIso } from '../domain.js';
import {
  ensureProject,
  getProject,
  listProjects,
  patchProject,
  type BaoStore,
} from '../store.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface AssistantHandle {
  readonly projectId: string;
  readonly sessionId: string;
  readonly agent: Agent;
  readonly owned: boolean;
}

export type OpenProjectResult =
  | { readonly ok: true; readonly project: ProjectRow; readonly assistant: AssistantHandle }
  | { readonly ok: false; readonly reason: string; readonly project?: ProjectRow };

export interface AssistantManagerDeps {
  readonly store: BaoStore;
  readonly config: ResolvedConfig;
  readonly host: HostApi;
  readonly log: LogFn;
}

export class AssistantManager {
  /** 本插件拥有的 C 句柄。关停时逐个 dispose（L2）。 */
  private readonly handles = new Map<string, AgentHandleLike>();
  private disposed = false;

  constructor(private readonly deps: AssistantManagerDeps) {}

  /**
   * 打开（或新建）一个项目，并确保它有活着的 C。
   *
   * 三条路径：
   * 1. 已在注册表 → 直接用（最常见）。
   * 2. 有 assistantSessionId 但不在注册表 → `resume`（D5 完整恢复）。
   * 3. 全新项目或有 id 但恢复失败 → `create` 一个新的 C。
   */
  async openProject(input: {
    readonly rootPath: string;
    readonly name?: string;
  }): Promise<OpenProjectResult> {
    const { store, config } = this.deps;
    const project = await ensureProject(store, {
      rootPath: input.rootPath,
      assistantPreset: config.assistantPreset,
      ...(input.name ? { name: input.name } : {}),
    });
    return this.ensureAssistant(project);
  }

  /** 确保某个已有项目有活着的 C。 */
  async ensureAssistant(project: ProjectRow): Promise<OpenProjectResult> {
    const { store, config, host, log } = this.deps;
    const registry = host.agents;
    if (!registry) {
      return {
        ok: false,
        reason:
          '宿主未提供 ctx.agents，无法创建项目助理 C。' +
          '请确认 dsh 装载了 @deepseek-ai/dsh-agent 与 @deepseek-ai/dsh-agent-loop。',
        project,
      };
    }

    // 1) 已在注册表：直接复用。
    if (project.assistantSessionId) {
      const live = registry.get(project.assistantSessionId);
      if (live) {
        await this.markRestored(project, true);
        return {
          ok: true,
          project: (await getProject(store, project.id)) ?? project,
          assistant: {
            projectId: project.id,
            sessionId: project.assistantSessionId,
            agent: live,
            owned: false,
          },
        };
      }

      // 2) 持久化过但当前不在场 → 冷恢复（D5）。
      const resumed = await this.tryResume(registry, project);
      if (resumed) {
        await this.markRestored(project, true);
        log('info', `项目 ${project.name} 的项目助理已从会话恢复：${resumed.sessionId}`);
        return {
          ok: true,
          project: (await getProject(store, project.id)) ?? project,
          assistant: resumed,
        };
      }
      log(
        'warn',
        `项目 ${project.name} 的项目助理恢复失败，将新建一个。` +
          '（D5 要求完整恢复；恢复失败时必须如实告知用户上下文已丢失。）',
      );
    }

    // 3) 新建 C。
    const created = await this.create(registry, project);
    if (!created.ok) {
      return { ok: false, reason: created.reason, project };
    }
    await this.markRestored(project, true);
    return {
      ok: true,
      project: (await getProject(store, project.id)) ?? project,
      assistant: created.assistant,
    };
  }

  private async tryResume(
    registry: AgentRegistryLike,
    project: ProjectRow,
  ): Promise<AssistantHandle | undefined> {
    if (!project.assistantSessionId) return undefined;
    try {
      const handle = await registry.resume({
        resumeSessionId: project.assistantSessionId,
        agentOptions: {},
      });
      this.handles.set(project.id, handle);
      return {
        projectId: project.id,
        sessionId: project.assistantSessionId,
        agent: handle.agent,
        owned: true,
      };
    } catch (error) {
      this.deps.log(
        'warn',
        `恢复项目助理会话 ${project.assistantSessionId} 失败：${errorText(error)}`,
      );
      return undefined;
    }
  }

  private async create(
    registry: AgentRegistryLike,
    project: ProjectRow,
  ): Promise<{ ok: true; assistant: AssistantHandle } | { ok: false; reason: string }> {
    const sessionId = newId('c');
    try {
      const handle = await registry.create({
        sessionId,
        // 刻意不传 parentAgent —— 这是根 Agent，不是某次 activation 的子代理。
        meta: {
          cwd: project.rootPath,
          agentPreset: project.assistantPreset,
        },
      });
      this.handles.set(project.id, handle);
      await patchProject(this.deps.store, project.id, {
        assistantSessionId: sessionId,
        assistantPreset: project.assistantPreset,
      });
      this.deps.log('info', `项目 ${project.name} 的项目助理已创建：${sessionId}`);
      return {
        ok: true,
        assistant: { projectId: project.id, sessionId, agent: handle.agent, owned: true },
      };
    } catch (error) {
      return {
        ok: false,
        reason: `创建项目助理失败：${errorText(error)}`,
      };
    }
  }

  private async markRestored(project: ProjectRow, restored: boolean): Promise<void> {
    if (project.assistantRestored === (restored ? 1 : 0)) return;
    await patchProject(this.deps.store, project.id, { assistantRestored: restored ? 1 : 0 });
  }

  /**
   * 取某个项目活着的 C。
   *
   * B 的转交、Reporter 的汇报都走这里。**取不到是常态而不是异常**：
   * 插件重启后 C 尚未恢复、或 handle 已被 dispose，都会返回 undefined。
   * 这种情况要如实回报，不能抛异常或假装成功（方案 §7.3 第 2 点）。
   */
  getAssistant(projectId: string): Agent | undefined {
    const registry = this.deps.host.agents;
    if (!registry) return undefined;
    const project = getProject(this.deps.store, projectId);
    if (!project?.assistantSessionId) return undefined;
    return registry.get(project.assistantSessionId);
  }

  /** 取 C 的会话 id（即使不在场也返回，用于展示"该项目的 C 是谁"）。 */
  sessionIdOf(projectId: string): string | undefined {
    return getProject(this.deps.store, projectId)?.assistantSessionId ?? undefined;
  }

  listProjects(): ProjectRow[] {
    return listProjects(this.deps.store);
  }

  /** 关停：逐个 dispose 自己建的 C（L2：没有父树统一收敛）。 */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [projectId, handle] of this.handles) {
      try {
        await handle.dispose();
      } catch (error) {
        this.deps.log('warn', `关停时 dispose 项目 ${projectId} 的 C 失败：${errorText(error)}`);
      }
    }
    this.handles.clear();
  }

  /** 已持有句柄的项目数（诊断用）。 */
  get ownedCount(): number {
    return this.handles.size;
  }

  /** 关停时间戳，供审计。 */
  get lastTouchedAt(): string {
    return nowIso();
  }

  // 供 Reporter / 工具层使用的只读投影。
  get storeRef(): BaoStore {
    return this.deps.store;
  }

  get configRef(): ResolvedConfig {
    return this.deps.config;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `[${code}] ${error.message}` : error.message;
  }
  return String(error);
}
