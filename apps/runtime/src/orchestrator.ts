/**
 * 编排核心：把 Assistant 与 Agent 连起来。
 *
 * 这个文件实现用户设想里最关键的几条：
 *
 * | 用户要求 | 这里怎么实现 |
 * | --- | --- |
 * | 用户对 Assistant 说话，C 立刻回复 | `say()` 同步入队，不等模型 |
 * | 连发不打断 | 消息进 Inbox，跑到步边界才被看到 |
 * | C 调多个 D 并行 | `spawn()` 立刻返回，Agent 在后台跑 |
 * | 谁先完成先汇报谁 | 每个 D 独立结算、独立回调，不等兄弟 |
 * | 写域互斥兜底 | `Gate` 在派发时排队 |
 * | C 主动推进 | 卡点分类 + 可继续使用的 message 通道 |
 *
 * 这里**不写 UI、不写 HTTP**：运行时只产生事件，上层（daemon / 桌面壳）
 * 决定怎么展示。
 */
import { EventEmitter } from 'node:events';
import { stat as fsStat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { auditSpawnClaims, correctionText, sanitizeSpawnClaims } from './assistant/spawnClaim.js';
import { Gate, normalizeWriteScopes, parseScopeClaim, type ScopeClaim } from './executor/gate.js';
import { decideSession, detectUserIntent } from './orchestrator/sessionPolicy.js';
import { INTERNAL_SOURCE_PREFIX } from './store/store.js';
import { makeTrigger, shouldWake } from './orchestrator/trigger.js';
import { evaluate } from './ticket/eval.js';
import { createMandate } from './ticket/mandate.js';
import { routeToSubscriber } from './ticket/subscription.js';
import {
  admit,
  DEFAULT_SOURCES,
  type SourceKind,
} from './ticket/source.js';
import { classifyBlock, executorSystemPrompt, type BlockKind, type ExecutorToolHostOptions } from './executor/executor.js';
import { runExecutorOnce, resumeExecutorOnce, priorMessagesFrom, type ExecutorRunnerDeps } from './executor/runner.js';
import { runLoop, type LoopEvent, type ToolHost } from './session/loop.js';
import { assistantSystemPrompt, assistantTools } from './assistant/prompt.js';
import { judgeConflict, AssistantSession } from './assistant/session.js';
import type { MarkdownMemoryStore, MemoryScope } from './memory/store.js';
import { extractCandidates } from './memory/extract.js';
import {
  buildGlobalOverview,
  checkBeforeSpawn,
  describeConflict,
  describeOverview,
  prioritize,
  type GlobalOverview,
  type ProjectOverview,
} from './global/overview.js';
import { TEMPLATES, applyTemplate, findTemplate, type AppliedTemplate, type TaskTemplate } from './templates/templates.js';
import { checkSchedules, type ScheduleSpec, type Suggestion } from './schedules/schedules.js';
import { MemoryScheduleStore, type ScheduleStorage } from './schedules/store.js';
import {
  MemoryCloseSettings,
  shouldConfirmQuit,
  type CloseAction,
  type CloseSettings,
  type CloseSettingsStoreLike,
} from './settings/close.js';
import {
  LEVEL_LABEL,
  MemoryPermissionStore,
  allowsWrite,
  levelForProject,
  needsApproval,
  type PermissionStoreLike,
} from './settings/permission.js';
import type { PermissionLevel } from './settings/permission.js';
import {
  DEFAULT_PLAN_GATE,
  planGateFor,
  type PlanGateSettings,
} from './settings/planGate.js';
import {
  canSpawnStep,
  createPlan,
  onStepDone,
  onStepFailed,
  transition,
} from './orchestrator/plan.js';
import { checkAllCommands } from './acceptance/portability.js';
import { MemoryModelStore, type ModelStoreLike } from './llm/modelStore.js';
import type { ModelSettings } from './llm/models.js';
import { mergeSkills, scanSkillRoot, type SkillSummary } from './skills/index.js';
import { McpManager, type McpServerConfig } from './mcp/client.js';
import { buildUsageReport, type UsageStats } from './insights/usage.js';
import { needsUserDecision } from './orchestrator/decisionRules.js';
import { FileSnapshotStore, type SnapshotStore } from './security/snapshot.js';
import { isUndoable, undoFileWrite } from './security/undo.js';
import { buildCheckpoints, rollbackCheckpoint, type Checkpoint } from './security/checkpoint.js';
import {
  isSearchConfigured,
  type SearchSettings,
  type SearchStoreLike,
} from './settings/search.js';
import {
  DEFAULT_ICON_THEME,
  normalizeIconTheme,
  type IconThemeStoreLike,
} from './settings/iconTheme.js';
import { EMPTY_METRICS } from './cost/metrics.js';
import { evaluateRunning, evaluateSpawn, startOfToday } from './cost/budget.js';
import { classifyDanger } from './security/classify.js';
import { requestApproval, expireStaleApprovals } from './security/approval.js';
import { verify } from './acceptance/verify.js';
import { parseCriteria } from './acceptance/criteria.js';
import type { AcceptancePolicy, AcceptanceResult, Criterion, CriterionResult } from './acceptance/criteria.js';
import type { Inbox } from './inbox/inbox.js';
import type { LlmClient, ToolDefinition } from './llm/types.js';
import {
  isExecutorTerminal,
  newId,
  normalizePath,
  type ExecutorRow,
  type ProjectRow,
  type ReportRow,
  type SessionRow,
  type Store,
  type TurnJudgment,
} from './store/store.js';
import type { ContentPart } from './llm/types.js';

export interface OrchestratorOptions {
  readonly store: Store;
  readonly llm: LlmClient;
  readonly maxConcurrentExecutors?: number;
  readonly maxStepsPerExecutor?: number;
  readonly commandTimeoutMs?: number;
  /** 项目记忆读取器；返回空串表示没有。 */
  readonly readMemory?: (project: ProjectRow) => Promise<string>;
  /**
   * 记忆存储。提供后，Assistant 会得到 remember / search_memory 两个工具，
   * 且每次开轮时按当前消息检索相关记忆注入系统提示。
   */
  readonly memory?: MarkdownMemoryStore;
  /** 危险动作审批的超时（毫秒）。默认 10 分钟，到点自动拒绝。 */
  readonly approvalTimeoutMs?: number;
  /** 定时配置存储；不提供时定时功能不可用。 */
  readonly schedules?: ScheduleStorage;
  /** 关闭行为设置；不提供时默认最小化到托盘。 */
  readonly closeSettings?: CloseSettingsStoreLike;
  /** 权限档位；不提供时默认「手动审批」。 */
  readonly permissions?: PermissionStoreLike;
  /**
   * 方案把关。**默认 `off`**——没有方案创建流程时强制拦截会让所有派活失败。
   *
   * 见 `settings/planGate.ts` 的说明：等方案创建流程做完再改默认值。
   */
  readonly planGate?: PlanGateSettings;
  /** 联网搜索配置的存取。不传时搜索工具永远"不可用"。 */
  readonly searchStore?: SearchStoreLike;
  /**
   * 应用图标配色。
   *
   * **壳层也要读**（窗口和托盘图标是 Tauri 建的，不是网页画的），
   * 所以除了 localStorage 还要落一份 JSON 供 Rust 侧读。
   */
  readonly iconThemeStore?: IconThemeStoreLike;
  /** 多模型配置；不提供时用内存实现。 */
  readonly models?: ModelStoreLike;
  /** 用户级技能目录；不提供时用 ~/.opencoxswain/skills。 */
  readonly userSkillsDir?: string;
  /** 文件快照存储；不提供时用 ~/.opencoxswain/snapshots。 */
  readonly snapshots?: SnapshotStore;
  /** MCP 服务器配置；不提供就不启用 MCP。 */
  readonly mcpServers?: readonly McpServerConfig[];
  /**
   * 用户扩展（geek 自定义口）。
   *
   * 只用于否决与观察工具调用，**不能**改参数、跳过审批、绕过验收。
   */
  readonly extensions?: ExecutorToolHostOptions['extensions'];
}

/** 运行时对外事件。上层据此推送 UI / IM / 日志。 */
export type RuntimeEvent =
  | { readonly type: 'assistant_text'; readonly projectId: string; readonly text: string }
  | { readonly type: 'executor_started'; readonly projectId: string; readonly executor: ExecutorRow }
  | { readonly type: 'executor_queued'; readonly projectId: string; readonly executor: ExecutorRow; readonly reason: string }
  | { readonly type: 'executor_settled'; readonly projectId: string; readonly executor: ExecutorRow; readonly ok: boolean }
  | { readonly type: 'report'; readonly projectId: string; readonly report: ReportRow }
  | {
      readonly type: 'approval_requested';
      readonly projectId: string;
      readonly approvalId: string;
      readonly category: string;
      readonly evidence: string;
    }
  | { readonly type: 'turn_judged'; readonly projectId: string; readonly turnId: string; readonly judged: TurnJudgment; readonly reason: string }
  | {
      readonly type: 'acceptance';
      readonly projectId: string;
      readonly executorId: string;
      readonly verdict: 'passed' | 'failed' | 'unverified';
      readonly results: readonly CriterionResult[];
    }
  | {
      readonly type: 'memory_candidates';
      readonly projectId: string;
      readonly created: number;
    };

export interface SpawnInput {
  readonly label: string;
  readonly goal: string;
  readonly writeScope?: readonly string[] | string;
  readonly judged?: TurnJudgment;
  /**
   * 验收标准。Assistant 派活时声明"怎么算做完了"。
   *
   * 不声明也能派，但那样就只能靠人看结论——**没有任何自动复核**。
   */
  readonly criteria?: readonly Criterion[];
  /** 验收策略，默认 unverified_only。 */
  readonly policy?: AcceptancePolicy;
  /**
   * 授权强度（进授权快照）。
   *
   * - `explicit`  用户明确要求了这件事
   * - `inferred`  Assistant 自己判断该做（默认）
   * - `automatic` 系统按规则自动派（定时、模板）
   */
  readonly strength?: 'explicit' | 'inferred' | 'automatic';
  /** 谁授权的：'user' | 'assistant' | 'schedule' | 'template'。 */
  readonly grantedBy?: string;
  /**
   * 用户这次说的话。
   *
   * 用来识别"开新会话 / 接着上次"这类明确要求。
   * 不给的话只能按策略自动判断。
   */
  readonly userText?: string;
  /**
   * 这个 Agent 执行的是方案的哪一步（如 'P0'）。
   *
   * 给了它，Agent 结算时会自动回填方案进度并推进下一步；
   * 不给就是普通临时任务，与方案无关。
   */
  readonly planStepId?: string;
}

export interface SpawnResult {
  readonly executor: ExecutorRow;
  readonly admitted: boolean;
  readonly queueReason: string;
  readonly judgmentNote: string;
}

/** 重启恢复结果，供启动时日志与 UI 展示。 */
export interface RecoveryReport {
  /** 上次运行中被中断、已被如实标记为失败的Agent。 */
  readonly interruptedExecutors: ExecutorRow[];
  /** 可从历史恢复的项目与它们的 Assistant 会话。 */
  readonly recoveredProjects: Array<{ projectId: string; name: string; assistantSessionId: string }>;
  /** 重启后作废的、曾经在等待中的审批数量。 */
  readonly expiredApprovals: number;
}

export class Orchestrator extends EventEmitter {
  private readonly store: Store;
  private readonly llm: LlmClient;
  private readonly maxConcurrent: number;
  private readonly gate: Gate;
  private readonly maxStepsPerExecutor: number;
  private readonly commandTimeoutMs: number | undefined;
  private readonly readMemory: ((project: ProjectRow) => Promise<string>) | undefined;
  private readonly memory: MarkdownMemoryStore | undefined;

  /** 每个项目的 Assistant 会话（内存句柄；历史在 store 里）。 */
  private readonly assistants = new Map<string, AssistantSession>();
  /** Agent 的中途输入通道：executorId → 待注入文本。 */
  private readonly executorInputs = new Map<string, string[]>();
  /** Agent 的中止控制器。 */
  private readonly executorAborts = new Map<string, AbortController>();
  /** 本次运行中止是否由用量止损触发（用于写准确的失败原因）。 */
  private tokenGuardTripped: string | null = null;
  /** 审批超时（毫秒）。到点自动拒绝，不让Agent无限挂起。 */
  private readonly approvalTimeoutMs: number | undefined;
  private readonly scheduleStore: ScheduleStorage;
  private readonly closeStore: CloseSettingsStoreLike;
  private readonly permissionStore: PermissionStoreLike;
  /** 方案把关设置（默认 off，见 settings/planGate.ts）。 */
  private readonly planGate: PlanGateSettings;
  /**
   * 联网搜索配置。
   *
   * 没配时 `web_search` 会明确告诉模型"不可用"——
   * 不能让它编造搜索结果。
   */
  private readonly searchStore: SearchStoreLike | null;
  /** 应用图标配色（壳层读这份）。 */
  private readonly iconThemeStore: IconThemeStoreLike | null;
  /**
   * 缓存的搜索配置。
   *
   * `runnerDeps` 是同步方法，不能在里面 await 读盘；
   * 所以在启动时和保存配置后调 `refreshSearchCache()` 更新。
   */
  private searchCache: { endpoint: string; apiKey: string } | null = null;
  private readonly modelStore: ModelStoreLike;
  /** 用户级技能目录（~/.opencoxswain/skills）。 */
  private readonly userSkillsDir: string;
  /** MCP 连接管理；没配置服务器时为 null。 */
  private mcp: McpManager | null = null;
  /** 文件快照（撤销用）。 */
  private readonly snapshots: SnapshotStore;
  /**
   * 本轮真实创建的 Agent id（按 Assistant 会话分）。
   *
   * 用途：核对 Assistant 有没有"预告派活"——
   * 它可能说"已派出 exe_xxx"但没调工具。只有这里记的 id 才算真的。
   */
  private readonly turnSpawnLog = new WeakMap<AssistantSession, string[]>();
  private readonly extensions: ExecutorToolHostOptions['extensions'] | undefined;
  private disposed = false;

  constructor(options: OrchestratorOptions) {
    super();
    this.store = options.store;
    this.llm = options.llm;
    this.maxConcurrent = options.maxConcurrentExecutors ?? 5;
    this.gate = new Gate(this.maxConcurrent);
    this.maxStepsPerExecutor = options.maxStepsPerExecutor ?? 40;
    this.commandTimeoutMs = options.commandTimeoutMs;
    this.readMemory = options.readMemory;
    this.memory = options.memory;
    this.approvalTimeoutMs = options.approvalTimeoutMs;
    // 没提供时用内存实现，保证方法可调用（只是不持久化）。
    this.scheduleStore = options.schedules ?? new MemoryScheduleStore();
    this.closeStore = options.closeSettings ?? new MemoryCloseSettings();
    this.permissionStore = options.permissions ?? new MemoryPermissionStore();
  this.planGate = options.planGate ?? DEFAULT_PLAN_GATE;
    this.searchStore = options.searchStore ?? null;
    this.iconThemeStore = options.iconThemeStore ?? null;
    this.modelStore = options.models ?? new MemoryModelStore();
    this.userSkillsDir = options.userSkillsDir ?? path.join(os.homedir(), '.opencoxswain', 'skills');
    // 快照目录：和 skills 同级，用户能直接看到
    this.snapshots =
      options.snapshots ??
      new FileSnapshotStore(path.join(os.homedir(), '.opencoxswain', 'snapshots'));
    // MCP：**启动失败不影响主流程**。服务器起不来只是少几个工具，
    // 不能让整个程序报错。所以启动是 fire-and-forget，失败静默。
    if (options.mcpServers && options.mcpServers.length > 0) {
      this.mcp = new McpManager(options.mcpServers);
      void this.mcp.start().catch(() => {
        /* 一个都连不上就算了 */
      });
    }
    this.extensions = options.extensions;
  }

  /**
   * 系统独立复核。
   *
   * 没有声明验收标准时返回 null——**不伪装成通过**。
   * 界面据此显示"未声明验收标准，需人工判断"。
   */
  private async runAcceptance(
    project: ProjectRow,
    executor: ExecutorRow,
    _approve: () => Promise<{ approved: boolean; reason: string }>,
  ): Promise<AcceptanceResult | null> {
    if (executor.criteria.length === 0) return null;

    const result = await verify({
      rootPath: project.displayPath,
      criteria: executor.criteria,
      policy: executor.policy,
      // 复核命令同样过审批闸门，防止用验收命令绕过 A2。
      approve: (tool, args) => this.approveFor(project.id, executor.id, tool, args),
      ...(this.commandTimeoutMs !== undefined ? { defaultTimeoutMs: this.commandTimeoutMs } : {}),
    });

    this.emit('runtime', {
      type: 'acceptance',
      projectId: project.id,
      executorId: executor.id,
      verdict: result.verdict,
      results: [...result.results],
    } as RuntimeEvent);

    return result;
  }

  /**
   * 构造运行器依赖。
   *
   * 首轮与续聊共用同一套装配——**这样"续聊要不要记账/走审批"就不会有人再漏**。
   * 之前两处各写一份，续聊就漏了副作用台账。
   */
  private runnerDeps(input: {
    projectId: string;
    executorId: string;
    /** 派活时扫好的技能列表；不给就不注入技能目录。 */
    skills?: readonly SkillSummary[];
    /** 用量止损判定；续聊不参与止损时传 undefined。 */
    tokenGuard?: ProjectRow['tokenGuard'];
    onAbort?: () => void;
  }): ExecutorRunnerDeps {
    return {
      store: this.store,
      llm: this.llm,
      maxSteps: this.maxStepsPerExecutor,
      ...(this.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: this.commandTimeoutMs }
        : {}),
      ...(this.extensions ? { extensions: this.extensions } : {}),
      ...(input.skills ? { skills: input.skills } : {}),
      // 快照：让写文件前留一份原内容，撤销才有数据可用
      snapshots: this.snapshots,
      // MCP：工具列表按当前连接取，连接还没建立时为空数组（不影响其它工具）。
      ...(this.mcp && this.mcp.listTools().length > 0
        ? { mcpTools: this.mcp.listTools(), mcp: this.mcp }
        : {}),
      // 联网搜索：用缓存的配置（runnerDeps 是同步的，这里不能 await）。
      // 缓存在 refreshSearchCache() 里更新。
      ...(this.searchCache ? { search: this.searchCache } : {}),
      approve: (tool, args) =>
        this.approveFor(input.projectId, input.executorId, tool, args),
      drainInputs: (executorId) => {
        const queue = this.executorInputs.get(executorId) ?? [];
        this.executorInputs.delete(executorId);
        return queue;
      },
      // 用量止损：每轮用量累积后检查，超线立即中止（不是等账单出来）。
      onProgressMetrics: (_executorId, partial) => {
        const guard = input.tokenGuard;
        if (!guard) return;
        const today = this.store.costSince(input.projectId, startOfToday());
        const evaluation = evaluateRunning(guard, partial, today);
        if (evaluation.status === 'exceeded') {
          this.tokenGuardTripped = evaluation.breached ?? '超出用量上限';
          input.onAbort?.();
        }
      },
      /**
       * 每轮文本都存成"当前进展"。
       *
       * 这不是最终结论（那由结算写），而是**被中断时的保底**：
       * 用户按停止之后，Assistant 至少能说出"它停之前做到哪了"。
       */
      onPartialText: (targetId, text) => {
        const current = this.store.getExecutor(targetId);
        if (!current) return;
        void this.store
          .putExecutor({ ...current, summary: text.slice(0, 4000) })
          .catch(() => {});
      },
    };
  }

  /**
   * 危险动作审批的统一入口（派活与续聊共用）。
   *
   * 只有 `approved: true` 才会真正执行；被拒绝或超时则动作**不会发生**，
   * 并把原因回灌给模型让它换个做法。
   */
  private async approveFor(
    projectId: string,
    executorId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; reason: string }> {
    const action = classifyDanger(tool, args);
    if (!action) {
      // 理论上不会走到这里（调用方只在命中时调），但保守起见放行。
      return { approved: true, reason: '非危险动作' };
    }

    // **权限档位挡在前面**：自动审批 / 完全权限直接放行，不打扰用户。
    // 放行的只是"要不要问"，副作用台账照记（那在 executor 层）。
    const level = (await this.permissionStore.load()).level;
    if (!needsApproval(level, action.category)) {
      await this.store.putApproval({
        id: newId('apv'),
        projectId,
        executorId,
        category: action.category,
        evidence: action.evidence,
        why: action.why,
        tool,
        args: JSON.stringify(args),
        // 状态用 approved，但理由写清是档位自动放行——
        // 事后查台账时能分辨"人点过头"还是"权限放过去的"。
        status: 'approved',
        decidedReason: `权限档位「${LEVEL_LABEL[level]}」自动放行`,
        createdAt: Date.now(),
        decidedAt: Date.now(),
        expiresAt: Date.now(),
      });
      this.emit('runtime', {
        type: 'approval_requested',
        projectId,
        approval: {
          id: '',
          projectId,
          executorId,
          category: action.category,
          evidence: action.evidence,
          why: `${LEVEL_LABEL[level]}：已自动放行`,
          status: 'approved',
        },
      });
      return { approved: true, reason: `权限档位「${LEVEL_LABEL[level]}」自动放行` };
    }

    const decision = await requestApproval(
      {
        store: this.store,
        projectId,
        executorId,
        ...(this.approvalTimeoutMs !== undefined ? { timeoutMs: this.approvalTimeoutMs } : {}),
        onCreated: (approvalId) => {
          // 通知 IM 通道：手机上也能批准/拒绝。
          this.emit('runtime', {
            type: 'approval_requested',
            projectId,
            approvalId,
            category: action.category,
            evidence: action.evidence,
          } as RuntimeEvent);
        },
        log: (level, message) => this.emit('runtime', {
          type: 'assistant_text',
          projectId,
          text: `（${level === 'warn' ? '警告' : '审批'}：${message}）`,
        } as RuntimeEvent),
      },
      tool,
      args,
      action,
    );

    if (!decision.approved) {
      // 如实告诉用户"动作没执行"，避免以为做了。
      await this.recordReport({
        projectId,
        executorId,
        kind: 'blocked',
        body:
          `已拦下一个${action.category}类危险动作：${action.evidence}\n` +
          `原因：${decision.reason}\n` +
          `说明：${action.why}`,
        needsUser: true,
      });
    }
    return { approved: decision.approved, reason: decision.reason };
  }

  // -------------------------------------------------------------------------
  // 项目
  // -------------------------------------------------------------------------

  /**
   * 新建或打开项目。同一路径永远得到同一个项目与同一个 C ——
   * 这是"项目的主人"能记住上下文的前提。
   */
  async openProject(input: {
    readonly rootPath: string;
    readonly name?: string;
  }): Promise<{ project: ProjectRow; session: AssistantSession }> {
    const normalized = normalizePath(input.rootPath);
    if (!normalized) throw new Error('项目路径不能为空');

    // **必须是个真实存在的目录**。
    //
    // 不校验的话，用户输错路径也能"成功打开"，得到一个空项目——
    // 之后每次派活都失败，但错误发生在很远的地方，很难对上原因。
    // 在入口挡住，错误信息就在用户输入的地方。
    let isDir = false;
    try {
      const info = await fsStat(normalized);
      isDir = info.isDirectory();
    } catch {
      throw new Error(`目录不存在或没有访问权限：${input.rootPath}`);
    }
    if (!isDir) {
      throw new Error(`这不是一个目录：${input.rootPath}`);
    }

    const existing = this.store.getProjectByPath(normalized);
    if (existing) {
      const session = await this.ensureAssistant(existing);
      return { project: existing, session };
    }

    const now = Date.now();
    const project: ProjectRow = {
      id: newId('prj'),
      name: input.name?.trim() || lastSegment(normalized),
      rootPath: normalized,
      displayPath: input.rootPath,
      assistantSessionId: newId('c'),
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    await this.store.putProject(project);
    const session = await this.ensureAssistant(project);
    return { project, session };
  }

  private async ensureAssistant(project: ProjectRow): Promise<AssistantSession> {
    const cached = this.assistants.get(project.id);
    if (cached) return cached;

    const memory = this.readMemory ? await this.readMemory(project) : '';
    const session = await AssistantSession.open({
      store: this.store,
      project,
      systemPrompt: assistantSystemPrompt({
        projectName: project.name,
        rootPath: project.displayPath,
        memory,
      }),
    });
    this.assistants.set(project.id, session);
    return session;
  }

  getAssistant(projectId: string): AssistantSession | undefined {
    return this.assistants.get(projectId);
  }

  // -------------------------------------------------------------------------
  // 用户 ↔ C
  // -------------------------------------------------------------------------

  /**
   * 用户对 Assistant 说一句。**立刻返回**。
   *
   * 如果 C 当前空闲，会在后台立刻开始一轮；如果正在跑，
   * 这条消息就排在 inbox 里等下一个边界（不打断）。
   *
   * `internal=true` 表示这是**系统内部的投递**（如Agent结算通知），
   * 不是用户说的话：它会进入 Assistant 的上下文，但不应出现在对话流里。
   */
  async userSays(
    projectId: string,
    text: string,
    options: {
      source?: string;
      target?: 'next' | 'step';
      internal?: boolean;
      /** 图片附件。**只有图片走这里**，文本文件的内容已经拼进 text。 */
      images?: readonly ContentPart[];
      /**
       * 这条消息来自哪个**来源**（对齐 DSH 的 Source）。
       *
       * 不传就按 'web' 处理（本机界面）。
       * 来源决定接收范围（是否要 @）和授权强度。
       */
      sourceKind?: SourceKind;
      /** 这条消息有没有指向 agent（IM 里就是有没有 @）。默认 true。 */
      mentionsAgent?: boolean;
    } = {},
  ): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目 ${projectId} 不存在`);
    const assistant = await this.ensureAssistant(project);

    // **Source 准入**：不该进来的消息在进上下文之前就丢掉。
    //
    // 对齐 DSH：*在监听范围之外的触发**进入领域之前**就丢弃它们。*
    //
    // 为什么必须在这里丢：一旦进了 Assistant 的上下文，模型就对它
    // 发言了——用户会看到一条无中生有的回复。
    //
    // 内部通知（结算、定时）不走准入：它们不是"来源"，是系统自己
    // 产生的事件，已经由 trigger 决定唤醒与否。
    if (!options.internal) {
      const kind = options.sourceKind ?? 'web';
      const config = DEFAULT_SOURCES[kind];
      const gate = admit(
        {
          source: kind,
          actor: 'local-user',
          text,
          mentionsAgent: options.mentionsAgent ?? true,
        },
        config,
      );
      if (!gate.accept) {
        // 丢弃但**留痕**：用户说过的每句话都要能查到，
        // 只是不让模型处理它。
        await assistant.recordUser(text, `dropped:${kind}`, false, options.images);
        return;
      }
    }

    // **Eval：先判断这条消息该怎么处理**（对齐 DSH 的评估层）。
    //
    // 只对**用户真正说的话**分类。内部通知（结算、定时）由 trigger
    // 决定唤醒与否，不需要再走一遍分类。
    if (!options.internal) {
      const executors = this.store.listExecutors({ projectId });
      const runningList = executors
        .filter((e) => e.status === 'running' || e.status === 'starting')
        .map((e) => ({ id: e.id, label: e.label, status: e.status }));

      // **Subscription：唯一在跑的 Agent 会自动收到补充消息**。
      //
      // 对齐 DSH：*后续讨论无需任何人再次 @ agent 就能抵达执行器。*
      //
      // 顺序很重要：**先看订阅，再走评估**。DSH 原话是
      // "通过这种方式抵达工单的人的消息**不进入评估**"——
      // 因为它已经明确是给那个 Agent 的补充，不是新工作。
      const route = routeToSubscriber(runningList, text);
      if (route.kind === 'executor') {
        try {
          await this.userSaysToExecutor(route.executorId, text);
          this.emit('runtime', {
            type: 'assistant_text',
            projectId,
            text: `（这句话已直接转给正在跑的 Agent「${route.reason}」，没有派新的）`,
          } as RuntimeEvent);
        } catch (error) {
          this.emit('runtime', {
            type: 'assistant_text',
            projectId,
            text: `（补充指令没能送达 Agent：${errorText(error)}）`,
          } as RuntimeEvent);
        }
        return;
      }

      const running = runningList.length;
      const verdict = evaluate(text, running);

      if (verdict.decision === 'ignore') {
        // 客套话：不进 Assistant 上下文，也不唤醒它。
        //
        // 但要**落库**——用户说的每句话都该留痕，只是不该让模型
        // 为此跑一轮。界面仍会显示这条消息，Assistant 不回。
        await assistant.recordUser(text, options.source ?? 'webapp', false, options.images);
        return;
      }

      if (verdict.decision === 'stop' && running > 0) {
        // **停下来**：直接把决定交给 Assistant，让它列出该停哪些。
        //
        // 不在这里直接 kill——"停"可能只指某一个 Agent，
        // Assistant 知道上下文，由它判断。
        const stopHint =
          `用户说「${text}」，意思是要停下来。\n` +
          `当前有 ${running} 个 Agent 在跑。请确认停哪些：` +
          '如果只有一个在跑就直接 cancel_executor；' +
          '有多个时先列出来问用户停哪个，不要一次全停。';
        assistant.say(stopHint, {
          source: 'eval',
          internal: true,
        });
        void this.pumpAssistant(project).catch(() => {});
        return;
      }
    }

    assistant.say(text, {
      ...(options.source ? { source: options.source } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.internal ? { internal: true } : {}),
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
    });

    // 不 await：Assistant 在后台自己跑，用户随时可以继续发。
    void this.pumpAssistant(project).catch((error: unknown) => {
      this.emit('runtime', {
        type: 'assistant_text',
        projectId,
        text: `Assistant执行出错：${errorText(error)}`,
      });
    });
  }

  /** Assistant 的主循环：有排队消息且当前空闲就跑一轮。 */
  private async pumpAssistant(project: ProjectRow): Promise<void> {
    const assistant = await this.ensureAssistant(project);
    if (assistant.isRunning || assistant.inbox.pendingCount === 0) return;

    const turn = assistant.beginTurn();
    try {
      await this.runAssistantTurn(project, assistant, turn.signal);
    } finally {
      turn.end();
      // 本轮跑完如果还有积压，接着开下一轮（连发的消息逐条得到回应）。
      if (assistant.inbox.pendingCount > 0 && !this.disposed) {
        void this.pumpAssistant(project).catch(() => {});
      }
    }
  }

  private async runAssistantTurn(
    project: ProjectRow,
    assistant: AssistantSession,
    signal: AbortSignal,
    /**
     * 已经自动重试过几次。
     *
     * 用于「谎报已派出」的自动重试（见 docs/incident-spawn-claim.md）。
     * 上限 1 次：重试仍失败就交给更正消息，不无限重试——
     * 模型如果就是不肯调工具，重试多少次都一样。
     */
    retryCount = 0,
  ): Promise<void> {
    const inputs = assistant.inbox.drainForStep();
    for (const item of inputs) {
      // 图片随消息一起落库：刷新/重启后历史里还能看到，
      // 且模型能从存储里拿到（是否真的发出去由模型能力决定）。
      await assistant.recordUser(item.text, item.source, item.internal, item.images);
    }

    // 用一个"只消费一轮"的 drain：本轮开头已取走全部消息。
    const messages = assistant.history();

    // **上下文健康检查**：污染太重就先清洗，再交给模型。
    //
    // ## 为什么需要（2026-11-15 实测）
    //
    // 用户反馈"Assistant 不肯派活，要说很多次"。查下来老项目的会话有
    // 144 条消息，其中：
    //
    //   49 条含 exe_ 的 assistant（谎报/样板）
    //   11 条「不成立」更正
    //   30 条 internal 系统注入（重试指令）
    //
    // —— 大部分上下文是**修补机制自己制造的噪音**。
    //
    // 模型看到这一串"说得像、做得不像"的先例，就不再调工具了。
    // **开新项目一次就成功**，证实是这个原因。
    //
    // 只在**污染比例过高**时清：偶尔一条不是什么问题，
    // 每轮都清会让模型失去连续感。
    {
      // 两道清洗：
      //   1. "声称已派出但没真派"的 assistant 消息（模型会照抄这种句式）
      //   2. **旧的 internal 注入**（重试指令、纠偏提示）——
      //      它们是诊断信息，不是用户说的话，留着只会让上下文变成
      //      "一堆系统在骂模型"的记录，反而干扰正常推理。
      //
      // 第 2 项**只清旧的**：最近 4 条保留（本轮的纠偏模型得看到）。
      const afterSpawn = sanitizeSpawnClaims(messages);
      const internalIdx: number[] = [];
      afterSpawn.forEach((m, i) => {
        if (m.role === 'user' && (m.content ?? '').includes('本轮**没有调用任何工具**')) {
          internalIdx.push(i);
        }
      });
      const keepFrom = Math.max(0, afterSpawn.length - 4);
      const cleaned = afterSpawn.filter((_, i) => !internalIdx.includes(i) || i >= keepFrom);

      const removed = messages.length - cleaned.length;
      // 去掉的量超过 1/4，或者超过 10 条 —— 说明历史已经病态了
      if (removed > 10 || (messages.length > 20 && removed / messages.length > 0.25)) {
        messages.length = 0;
        messages.push(...cleaned);
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text:
            `（上下文已整理：剔除 ${removed} 条"声称已派出但没真派"的旧消息和过期纠偏提示，` +
            `剩余 ${cleaned.length} 条。这类记录会让模型学不会调工具。）`,
        } as RuntimeEvent);
      }
    }
    // 记忆注入：拿这一轮**用户真正说的话**去检索。
    // 内部通知（结算等）里含Agent 的原始输出，用它检索会召回无关记忆。
    const userInputs = inputs.filter((i) => !i.internal);
    if (this.memory && userInputs.length > 0) {
      try {
        const query = userInputs.map((i) => i.text).join('\n');
        const rendered = await this.memory.renderForPrompt(
          { kind: 'project', projectKey: project.rootPath },
          query,
        );
        if (rendered.trim() && messages[0]?.role === 'system') {
          messages[0] = {
            role: 'system',
            content: `${messages[0].content}\n\n## 项目规则与记忆\n${rendered}`,
          };
        }
      } catch (error) {
        // 记忆读不出来不能阻断对话。
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text: `（读取记忆失败，本轮不带记忆继续：${errorText(error)}）`,
        } as RuntimeEvent);
      }
    }
    const toolHost = this.createAssistantToolHost(project, assistant);

    /**
     * 本轮**真实创建**的 Agent id。
     *
     * 用于核对 Assistant 有没有"预告派活"：
     * 它可能说"已派出 exe_xxx"但没调工具。
     * 这里只记工具真的返回的 id。
     */
    const spawnedThisTurn: string[] = [];
    this.turnSpawnLog.set(assistant, spawnedThisTurn);

    let finalText = '';
    for await (const event of runLoop({
      llm: this.llm,
      toolHost,
      messages,
      maxSteps: 12,
      signal,
      // 本轮之后新到的消息留给下一轮，不在本轮中途插入 —— 这正是"不打断"。
      drainInputs: () => [],
    })) {
      if (event.type === 'assistant_text') {
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text: event.text,
        } as RuntimeEvent);
      }
      if (event.type === 'done') finalText = event.finalText;
      if (event.type === 'error') {
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text: `（Assistant出错：${event.message}）`,
        } as RuntimeEvent);
      }
    }

    // **核对"已派出"的说法**。
    //
    // 实测踩过：Assistant 声称"已派出 exe_xxx"，但它没有调用 spawn_executor，
    // 数据库里查不到那个 Agent。用户以为活派了，实际什么都没跑。
    //
    // 提示词里已经写了"不许预告派活"，但软约束不够——
    // 这里在运行时补一道硬检查：说了但没派的，追加一条更正。
    const audit = auditSpawnClaims(finalText, spawnedThisTurn);

    // **这一轮的"主任务"是汇报，不是派活**。
    //
    // ## 实测（2026-11-15，用户截图）
    //
    //   15:41:02  internal:executor  【Agent结算】Agent「定位前端提示」已完成
    //   15:41:02  assistant          Agent 的输出（summary）
    //   15:41:02  assistant          排查完成。以下是完整结论…        ← 这是汇报
    //   （用户消息）
    //   15:41:08  internal:system    你上一条说「已派出」但本轮没调工具
    //   15:41:08  assistant          ⚠ 更正：上一条说的「已派出」不成立
    //
    // 用户要的"汇报结果"没出现 —— 被谎报重试打断了。
    //
    // 根因：**结算通知和用户消息在同一轮里到达**，模型既要汇报又想说
    // "我再派一个"，后者谎报 → 整轮被重试覆盖 → 汇报丢失。
    //
    // 修法：本轮若有结算通知，**汇报优先**。谎报的那句仍然不进历史
    // （防污染），但**不再触发重试**——因为重试会把已经写好的汇报顶掉。
    //
    // 代价：这一轮没派成的活要等用户下一句。但"结果没汇报"比
    // "多问一句"糟得多：用户不知道活干完了。
    const reportingTurn = messages.some(
      (m) => m.role === 'user' && (m.content ?? '').includes(INTERNAL_NOTICE_PREFIX),
    );

    // **谎报的回复不写进历史**。
    //
    // 这是"Assistant 很难主动派活"的根因。
    //
    // 原来这里无条件 `recordAssistant(finalText)` —— 于是每一句
    // 「已派出 exe_xxx」都变成了后续推理的**范例**。模型下一轮看到
    // 前任这么写，就照抄句式、依然不调工具，污染越滚越大。
    //
    // 实测用户的库：793 条 assistant 消息里 59 条含「已派出」，
    // 最严重的会话 25 条。用户得说很多次"需要"它才动。
    //
    // 所以：**先判断，再落库**。谎报的那句只用在更正里，
    // 不进上下文。
    if (!audit.wrong) {
      await assistant.recordAssistant(finalText);
    } else if (reportingTurn) {
      // 汇报轮：保留正文（里面可能有真正的汇报），只把谎报那句去掉。
      // 简单做法：整段丢弃并用更正替代——但用户要的是汇报内容，
      // 所以这里**保留**，只是不再重试。
      await assistant.recordAssistant(finalText);
    }

    // **自动重试一次**。
    //
    // 实测（docs/incident-spawn-claim.md）：长会话里模型会模仿历史里的
    // 「已派出 exe_xxx」句式，复现文字但不调用工具。老项目连续两次谎报，
    // 同样的任务在新建项目里一次成功——根因是上下文里的范式模仿。
    //
    // 只纠正不重试的话，用户还得自己再说一遍。这里补一次自动重试：
    // 把上一轮的错误回复从上下文里换掉，明确要求"必须调用工具"。
    //
    // **汇报轮不重试**（见上面 reportingTurn 的注释）：重试会把
    // 已经写好的汇报顶掉，用户就看不到结果了。
    if (audit.wrong && !reportingTurn && retryCount < 1 && !signal.aborted) {
      const correction =
        '你上一条说「已派出」但本轮**没有调用任何工具**，实际没有创建 Agent。\n' +
        '现在重新处理：如果这件事需要派活，**直接调用 spawn_executor**；' +
        '不需要派活就直接回答，不要再声称「已派出」。';
      this.emit('runtime', {
        type: 'assistant_text',
        projectId: project.id,
        text: `（检测到未真实派活，正在重试一次）`,
      } as RuntimeEvent);

      // 重试：**清洗整段历史里"声称派活"的消息**，再换成明确的纠正指令。
      //
      // ## 为什么不是只 pop 一条
      //
      // 原来只 `messages.pop()` 掉最后一条，但根因不是"这一条错了"，
      // 而是**历史里积了几十条「已派出 exe_xxx」的样板**——模型照着模仿，
      // 复现文字但不调工具（见 docs/incident-spawn-claim.md）。
      //
      // 实测（2026-11-15 用户的库）：793 条 assistant 消息里 59 条含「已派出」，
      // 最严重的会话有 25 条。只删最后一条，剩下 24 条还是范本。
      //
      // 更糟的是纠正消息本身也含"已派出"三个字，等于又加一份样板。
      // 所以纠正语里不再引用原句，历史里的样板也一并抹掉。
      const cleaned = sanitizeSpawnClaims(messages);
      const removed = messages.length - cleaned.length;

      messages.length = 0;
      messages.push(...cleaned);
      messages.push({ role: 'user', content: correction });
      await assistant.recordUser(correction, 'system', true);

      if (removed > 0) {
        // 走 runtime 事件而不是 console：壳层和界面都能看到这次清洗。
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text: `（已从上下文剔除 ${removed} 条"声称已派出"的旧消息，避免模型继续照抄句式）`,
        } as RuntimeEvent);
      }

      void this.runAssistantTurn(project, assistant, signal, retryCount + 1);
      return;
    }

    if (audit.wrong) {
      // **汇报轮不追加更正**。
      //
      // 更正会盖住刚要汇报的内容（用户看到的最后一条变成
      // "⚠ 更正：上一条不成立"，而不是 Agent 的结果）。
      // 这一轮的目标是让用户知道活干完了，谎报那句话本身没落地就行——
      // 它没被记录成历史里的"已派出"样板，污染不会扩散。
      if (reportingTurn) {
        // 只补一句轻提示，不抢汇报的位置。
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          text: '（注：上面这句话只是预告，没有真的派出去。需要的话说一声。）',
        } as RuntimeEvent);
      } else {
        const text = correctionText(audit.phantomIds, audit.vagueClaim);
        // **必须落库**：只 emit 的话，日志里能看到、界面刷新后就没了，
        // 消息列表也查不到——等于没纠正。（2026-11-15 实测）
        await assistant.recordAssistant(text);
        this.emit('runtime', {
          type: 'assistant_text',
          projectId: project.id,
          // 无 id 的笼统声称（"已派出，两个都在跑"）也要纠正——
          // 2026-11-15 实测：模型这样说但没调用任何工具，running=0。
          text,
        } as RuntimeEvent);
      }
    }
  }

  /** Assistant 的工具执行宿主。 */
  private createAssistantToolHost(
    project: ProjectRow,
    assistant: AssistantSession,
  ): ToolHost {
    return {
      definitions: (): ToolDefinition[] => assistantTools(),
      execute: async ({ name, args }) => {
        try {
          switch (name) {
            case 'spawn_executor': {
              // 验收标准先解析：格式不对就在派活前拒绝，而不是等 D 跑完才发现没法验收。
              let criteria: Criterion[] = [];
              if (args.criteria !== undefined) {
                try {
                  criteria = parseCriteria(args.criteria);
                } catch (error) {
                  return {
                    ok: false,
                    content: `验收标准不合法，未派活：${errorText(error)}`,
                  };
                }
              }
              const result = await this.spawn(project.id, {
                label: String(args.label ?? ''),
                goal: String(args.goal ?? ''),
                writeScope: (args.writeScope as string[] | undefined) ?? [],
                ...(typeof args.judged === 'string'
                  ? { judged: args.judged as TurnJudgment }
                  : {}),
                ...(criteria.length > 0 ? { criteria } : {}),
                ...(typeof args.policy === 'string'
                  ? { policy: args.policy as AcceptancePolicy }
                  : {}),
                // 用户原文：用来识别"开新会话 / 接着上次"这类明确要求。
                // 取最近一条真实用户消息（内部通知不算）。
                userText: this.latestUserText(project.id),
                ...(typeof args.planStepId === 'string' && args.planStepId.trim()
                  ? { planStepId: args.planStepId.trim() }
                  : {}),
              });
              // 记下真实创建的 id——本轮结束时核对"已派出"的说法
              this.turnSpawnLog.get(assistant)?.push(result.executor.id);
              return {
                ok: true,
                content: [
                  `已派出Agent「${result.executor.label}」（${result.executor.id}），状态 ${result.executor.status}。`,
                  result.admitted ? '' : `（排队中：${result.queueReason}）`,
                  result.judgmentNote,
                  `当前运行 ${this.gate.stats().running}/${this.gate.stats().limit}，排队 ${this.gate.stats().queued}。`,
                ]
                  .filter(Boolean)
                  .join('\n'),
              };
            }
            case 'message_executor': {
              const id = String(args.executorId ?? '');
              const row = this.store.getExecutor(id);
              if (!row || row.projectId !== project.id) {
                return { ok: false, content: `Agent ${id} 不属于本项目` };
              }
              if (isExecutorTerminal(row.status)) {
                return { ok: false, content: `Agent ${id} 已结束（${row.status}），无法接收指令` };
              }
              const queue = this.executorInputs.get(id) ?? [];
              queue.push(String(args.message ?? ''));
              this.executorInputs.set(id, queue);
              return { ok: true, content: `已把指令转给Agent ${id}（不打断它当前这轮）` };
            }
            case 'list_executors': {
              const rows = this.store.listExecutors({ projectId: project.id });
              const statusFilter = Array.isArray(args.status) ? (args.status as string[]) : null;
              const filtered = statusFilter ? rows.filter((r) => statusFilter.includes(r.status)) : rows;
              if (filtered.length === 0) return { ok: true, content: '本项目还没有Agent。' };
              return {
                ok: true,
                content: filtered
                  .map((r) => {
                    const scope = r.writeScope.length ? `[写域 ${r.writeScope.join(',')}]` : '[未声明写域]';
                    const extra = r.blockedReason
                      ? ` — 卡点：${firstLine(r.blockedReason)}`
                      : r.summary
                        ? ` — ${firstLine(r.summary)}`
                        : '';
                    return `- [${r.status}] ${r.label}（${r.id}）${scope}${extra}`;
                  })
                  .join('\n'),
              };
            }
            case 'cancel_executor': {
              const id = String(args.executorId ?? '');
              return this.cancel(id, project.id);
            }
            case 'propose_plan': {
              // 出方案：把步骤落库，状态置 awaiting-approval，等用户批准。
              //
              // 这一轮**不许再派活**——方案就是用来先看后批的。
              // 提示词里已经这么要求，这里再兜一次：调用方拿到明确的
              // 「本轮结束」信号，不会被后面的工具调用绕过去。
              const stepsRaw = Array.isArray(args.steps) ? args.steps : [];
              if (stepsRaw.length === 0) {
                return { ok: false, content: '方案至少要有一个步骤' };
              }

              const steps = stepsRaw.map((raw, i) => {
                const s = raw as Record<string, unknown>;
                let criteria: Criterion[] = [];
                try {
                  criteria = parseCriteria(s.criteria ?? []);
                } catch (error) {
                  throw new Error(`第 ${i + 1} 步的验收标准不合法：${errorText(error)}`);
                }
                // **派活前就检查验收命令能不能跑**（见 acceptance/portability.ts）。
                // 不能等 Agent 跑完一轮才发现所有验收都红。
                const commands = criteria
                  .filter((c) => c.type === 'command' && c.check)
                  .map((c) => c.check as string);
                const report = checkAllCommands(commands);
                if (!report.allUsable) {
                  throw new Error(
                    `第 ${i + 1} 步有验收命令在当前平台跑不了：` +
                      report.problems.map((p) => `${p.command}（${p.reason}）`).join('；') +
                      '。请改成跨平台命令（node / pnpm / git）或本平台写法后重新提交方案。',
                  );
                }
                return {
                  id: `P${i}`,
                  title: String(s.title ?? `第 ${i + 1} 步`),
                  goal: String(s.goal ?? ''),
                  writeScope: Array.isArray(s.writeScope)
                    ? (s.writeScope as string[])
                    : ['readonly'],
                  criteria,
                  acceptancePolicy: 'unverified_only' as const,
                  dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as string[]) : undefined,
                };
              });

              // 一个项目同时只该有一条活跃方案；有就替换（用户可能想重来）。
              const existing = this.store.activePlanOf(project.id);
              const planId = existing?.id ?? `plan_${newId('p')}`;
              const draft = createPlan({
                id: planId,
                projectId: project.id,
                goal: String(args.goal ?? ''),
                steps,
              });
              const awaiting = transition(draft, 'awaiting-approval');
              await this.store.putPlan(awaiting);

              this.emit('runtime', {
                type: 'assistant_text',
                projectId: project.id,
                text:
                  `方案已出（${steps.length} 步），等你批准。\n` +
                  steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n'),
              } as RuntimeEvent);

              await this.recordReport({
                projectId: project.id,
                executorId: null,
                kind: 'question',
                body:
                  `方案待批准：${awaiting.goal}\n\n` +
                  steps.map((s, i) => `P${i} ${s.title}：${s.goal.slice(0, 80)}`).join('\n'),
                needsUser: true,
              });

              return {
                ok: true,
                content:
                  `方案已提交（id ${planId}，${steps.length} 步），状态 awaiting-approval。\n` +
                  '**本轮到此结束**：等用户批准后再派活，现在不要调用 spawn_executor。',
              };
            }
            case 'report_to_user': {
              const body = String(args.body ?? '');
              const needsUser = args.needsUser === true;
              await this.recordReport({
                projectId: project.id,
                executorId: null,
                kind: needsUser ? 'question' : 'progress',
                body,
                needsUser,
              });
              this.emit('runtime', {
                type: 'assistant_text',
                projectId: project.id,
                text: body,
              } as RuntimeEvent);
              return { ok: true, content: '已汇报给用户' };
            }
            case 'remember': {
              if (!this.memory) {
                return { ok: false, content: '本项目未启用记忆功能' };
              }
              const text = String(args.text ?? '');
              const kind = String(args.kind ?? 'project') as 'profile' | 'project' | 'decision' | 'lesson';
              const scope =
                String(args.scope ?? '') === 'global' || kind === 'profile'
                  ? ({ kind: 'global' } as const)
                  : ({ kind: 'project', projectKey: project.rootPath } as const);
              const result = await this.memory.write(scope, {
                kind,
                text,
                source: `项目 ${project.name} · Assistant会话 ${assistant.sessionId}`,
              });
              if (!result.ok) {
                // 拒绝原因要如实回给模型，让它知道为什么没记住。
                return { ok: false, content: `没有写入记忆：${result.reason}` };
              }
              return {
                ok: true,
                content: result.replaced
                  ? '已更新对应的旧记忆。'
                  : `已记住（${scope.kind === 'global' ? '全局' : '本项目'}）。`,
              };
            }
            case 'search_memory': {
              if (!this.memory) {
                return { ok: false, content: '本项目未启用记忆功能' };
              }
              const query = String(args.query ?? '');
              const matches = await this.memory.search(query, {
                kind: 'project',
                projectKey: project.rootPath,
              });
              if (matches.length === 0) return { ok: true, content: '没有找到相关记忆。' };
              return {
                ok: true,
                content: matches
                  .map(
                    (m) =>
                      `- [${m.scope === 'global' ? '全局' : '项目'}/${m.entry.kind}] ${m.entry.text}（${m.reason}）`,
                  )
                  .join('\n'),
              };
            }
            default:
              return { ok: false, content: `未知工具：${name}` };
          }
        } catch (error) {
          return { ok: false, content: errorText(error) };
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Agent 的派发与结算
  // -------------------------------------------------------------------------

  /**
   * 派一个 Agent。**立刻返回**，Agent 在后台跑。
   *
   * @returns admitted=false 表示在排队（写域相交或达并发上限）。
   */
  /**
   * 取最近一条**真实用户消息**的文本。
   *
   * 用途：识别"开新会话 / 接着上次"这类明确要求。
   * 内部通知（`internal`）不算——那是系统自己说的话。
   */
  private latestUserText(projectId: string): string {
    const project = this.store.getProject(projectId);
    if (!project) return '';
    const messages = this.store.messages(project.assistantSessionId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role !== 'user') continue;
      // 内部通知的来源以 `internal:` 开头，那是系统自己说的话
      if (m.source.startsWith(INTERNAL_SOURCE_PREFIX)) continue;
      return m.content;
    }
    return '';
  }

  /**
   * 为一次新派活决定用哪个会话。
   *
   * ## 为什么需要
   *
   * 原来每个 Agent 都开全新会话（`newId('d')`），实测 12 个 Agent
   * 用了 12 个不同会话——**提示缓存完全无法命中**，
   * 模型每次都要重新处理系统提示和工具定义。
   *
   * ## 策略在 sessionPolicy.ts
   *
   * 用户明确要求优先；没有的话看冷却时间、会话长度、任务相关性。
   * 这里只负责从库里收集候选，判断交过去。
   */
  private chooseSession(
    project: ProjectRow,
    goal: string,
    userText: string,
  ): { sessionId: string; reason: string; reused: boolean } {
    // 候选：同项目里跑成功的 Agent 会话，最近的优先
    const candidates = this.store
      .listExecutors({ projectId: project.id })
      .filter((e) => e.sessionId && e.status === 'done')
      .slice(0, 5)
      .map((e) => {
        const messages = this.store.messages(e.sessionId);
        const tokens = messages.reduce((n, m) => n + Math.ceil(m.content.length / 2.5), 0);
        return {
          sessionId: e.sessionId,
          messageCount: messages.length,
          tokens,
          lastActiveAt: e.endedAt ?? e.createdAt,
          lastGoal: e.goal,
          succeeded: e.status === 'done',
        };
      });

    const decision = decideSession({
      candidates,
      goal,
      userWants: detectUserIntent(userText),
      now: Date.now(),
    });

    return {
      sessionId: decision.sessionId ?? newId('d'),
      reason: decision.reason,
      reused: decision.choice === 'reuse',
    };
  }

  async spawn(projectId: string, input: SpawnInput): Promise<SpawnResult> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目 ${projectId} 不存在`);
    if (!input.label.trim() || !input.goal.trim()) {
      throw new Error('派活必须提供 label 与 goal');
    }

    // 方案把关：**默认 off**，开启后没批准的方案不许派活。
    //
    // 这是 `plan-approval.md` D1「方案给用户看完才开工」在代码里的落点。
    // 之所以默认关闭：目前还没有「创建方案」的流程，
    // 一上来就拦会让所有派活失败（见 settings/planGate.ts 的说明）。
    //
    // 用抛错而不是返回假 SpawnResult：`executor` 是必填字段，
    // 造一个假对象会让调用方无法分辨"真派了但排队"和"根本没派"。
    if (planGateFor(this.planGate, projectId) === 'on') {
      const active = this.store.activePlanOf(projectId);
      if (active) {
        const gate = canSpawnStep(active);
        if (!gate.allowed) {
          const reason = gate.reason ?? '方案还没批准';
          await this.recordReport({
            projectId,
            executorId: null,
            kind: 'blocked',
            body: `已拒绝派活：${reason}。\n方案批准之后才会开工。`,
            needsUser: true,
          });
          throw new Error(`已拒绝派活：${reason}`);
        }
      }
    }

    // 用量止损：已经超了就别再派。这是**硬拒绝**，不是排队——
    // 排队会让用户以为等一会儿就能跑，实际上永远不会。
    if (project.tokenGuard) {
      const today = this.store.costSince(projectId, startOfToday());
      const guard = evaluateSpawn(project.tokenGuard, today);
      if (guard.status === 'exceeded') {
        const reason = guard.breached ?? '今日用量已达上限';
        await this.recordReport({
          projectId,
          executorId: null,
          kind: 'blocked',
          body:
            `已拒绝派活：${reason}。\n` +
            '这是防止额度被一次性烧光的止损线，不是计费。' +
            '如果确实要继续，请在设置里调高上限，或等明天重置。',
          needsUser: true,
        });
        throw new Error(
          `已拒绝派活：${reason}。请在设置里调高用量上限，或等明天重置。`,
        );
      }
    }

    // 解析访问形态：只读任务不参与写域互斥，因此三条只读任务能真正并行。
    // （早期版本把"只读"和"没声明写域"混为一谈，导致并行失效。）
    const claim = parseScopeClaim(input.writeScope);

    // **权限档位可以收紧，不能放松**。
    // 「仅可查看」档下即使模型要求写域，也强制降级成只读——
    // 否则档位形同虚设，模型一句话就能绕过用户设置。
    const permissionLevel = (await this.permissionStore.load()).level;
    const effectiveAccess: 'readonly' | 'readwrite' =
      claim.access === 'readonly' || !allowsWrite(permissionLevel) ? 'readonly' : claim.access;

    // **跨项目写冲突检查**：项目内的写域互斥（Gate）只看相对路径，
    // 两个互不相干的项目都有 src/ 但那不是冲突。真正危险的是
    // 两个项目在改同一个绝对路径 —— 后写的覆盖先写的，两边台账都记"成功"。
    // 这条检查只在"其它项目正在跑"时才有意义。
    const crossConflict = checkBeforeSpawn(this.store, project, {
      agentId: 'pending',
      label: input.label.trim(),
      writeScope: claim.scopes,
      readonly: claim.access === 'readonly',
    });
    if (crossConflict) {
      const reason = describeConflict(crossConflict);
      await this.recordReport({
        projectId,
        executorId: null,
        kind: 'blocked',
        body: `已拒绝派活「${input.label}」：${reason}`,
        needsUser: true,
      });
      throw new Error(`已拒绝派活：${reason}`);
    }

    const active = this.store
      .listExecutors({ projectId })
      .filter((e) => !isExecutorTerminal(e.status))
      .map((e) => ({ id: e.id, label: e.label, writeScope: e.writeScope, access: e.access }));

    const judgment = judgeConflict({ claim, active });
    const judged: TurnJudgment = input.judged ?? judgment.judged;
    let judgmentNote = '';
    if (input.judged && input.judged !== judgment.judged && judgment.judged === 'conflict') {
      // C 说可并行，但写域相交：如实告诉它，让它可以调整。
      judgmentNote = `注意：你判定为「${labelOf(input.judged)}」，但${judgment.reason}。会被写域闸门串行。`;
    } else if (!input.judged) {
      judgmentNote = `（按写域判定为「${labelOf(judged)}」：${judgment.reason}）`;
    }

    const now = Date.now();

    // **会话复用**：能在旧会话上接着干就接着干，让提示缓存命中。
    // 判断逻辑在 sessionPolicy.ts；这里只拿结果。
    const session = this.chooseSession(project, input.goal.trim(), input.userText ?? '');

    // 授权快照要用当前的权限档位——在这里一次取好。
    const mandateLevel = await this.effectivePermission(projectId);

    const executor: ExecutorRow = {
      id: newId('exe'),
      projectId,
      sessionId: session.sessionId,
      label: input.label.trim(),
      goal: input.goal.trim(),
      access: effectiveAccess,
      writeScope: claim.scopes,
      status: 'starting',
      summary: null,
      blockedReason: null,
      metrics: EMPTY_METRICS,
      criteria: input.criteria ?? [],
      policy: input.policy ?? 'unverified_only',
      acceptance: null,
      ...(input.planStepId ? { planStepId: input.planStepId } : {}),
      // **授权快照**（对齐 DSH 的 Mandate）。
      //
      // 派活那一刻把权限档位和写域定格。之后用户改全局权限，
      // 只影响新派的活——**正在跑的这个仍然用它被授权时的规则**。
      //
      // 这是"不可变"的实际含义：用户以为改权限是"以后生效"，
      // 如果现查全局值，当下的任务会跟着换规则，那就是他没想到的越权。
      mandate: createMandate({
        level: mandateLevel,
        scope: claim.scopes,
        // 强度由派活来源决定：用户明确说了就是 explicit，
        // Assistant 自己判断要派是 inferred，定时/模板是 automatic。
        strength: input.strength ?? 'inferred',
        grantedBy: input.grantedBy ?? 'assistant',
        policyVersion: this.permissionPolicyVersion(),
        now,
      }),
      createdAt: now,
      endedAt: null,
    };
    await this.store.putExecutor(executor);

    // 记一条 turn，留痕"这条需求被判定成什么"，让 Assistant 判错可审计。
    await this.store.appendTurn({
      id: newId('turn'),
      projectId,
      role: 'assistant',
      source: 'assistant',
      executorId: executor.id,
      text: `${executor.label}：${executor.goal}`,
      judged,
      at: now,
    });
    this.emit('runtime', {
      type: 'turn_judged',
      projectId,
      turnId: executor.id,
      judged,
      reason: judgment.reason,
    } as RuntimeEvent);

    const conflict = this.gate.check(executor.id, claim);
    const admitted = !conflict.conflicts && this.gate.hasFreeSlot;
    const queueReason = conflict.conflicts
      ? (conflict.reason ?? '写域冲突')
      : admitted
        ? ''
        : `已达并发上限 ${this.maxConcurrent}`;

    if (admitted) {
      this.emit('runtime', { type: 'executor_started', projectId, executor } as RuntimeEvent);
    } else {
      this.emit('runtime', {
        type: 'executor_queued',
        projectId,
        executor,
        reason: queueReason,
      } as RuntimeEvent);

      // **写域冲突要回灌给 Assistant**。
      //
      // 之前只排队，不告诉它——它以为派出去就完事了。
      // 实测发现：Assistant 其实有"别让两个 Agent 改同一个文件"的自觉，
      // 但那是它自己判断的，系统没有兜底。
      //
      // 这里把系统侧的结论告诉它：撞了哪条写域、和谁撞的。
      // 它下一轮就能决定是等、还是换个做法。
      if (conflict.conflicts) {
        void this.notifyWriteConflict(project, executor, conflict).catch(() => {
          /* 通知失败不影响排队 —— 事实已落库 */
        });
      }
    }

    // 后台跑，不阻塞 C。
    void this.runExecutorBackground(project, executor).catch((error: unknown) => {
      this.emit('runtime', {
        type: 'executor_settled',
        projectId,
        executor,
        ok: false,
      } as RuntimeEvent);
      void error;
    });

    return { executor, admitted, queueReason, judgmentNote };
  }

  private async runExecutorBackground(project: ProjectRow, executor: ExecutorRow): Promise<void> {
    const { store } = this;
    try {
      await this.gate.acquire(executor.id, {
        access: executor.access,
        scopes: executor.writeScope,
      });
    } catch (error) {
      const current = store.getExecutor(executor.id);
      if (current && !isExecutorTerminal(current.status)) {
        await this.finishExecutor(executor.id, 'cancelled', `排队期间中止：${errorText(error)}`, undefined, 'system');
      }
      return;
    }

    const ready = store.getExecutor(executor.id);
    if (!ready || isExecutorTerminal(ready.status)) {
      this.gate.release(executor.id);
      return;
    }

    // 建 Agent 的会话行（历史可回看 = "打开原会话"）。
    // systemPrompt 存下来，续聊时才能重建同样的角色设定。
    //
    // 技能在派活时扫一次：改了技能文件立刻生效，不用重启。
    const skills = await this.skillsFor(project);
    const session: SessionRow = {
      id: ready.sessionId,
      kind: 'executor',
      projectId: project.id,
      parentSessionId: project.assistantSessionId,
      label: ready.label,
      systemPrompt: executorSystemPrompt({
        projectName: project.name,
        goal: ready.goal,
        writeScope: ready.writeScope,
        ...(ready.access === 'readonly' ? { readonlyTask: true } : {}),
        skills,
      }),
      status: 'running',
      resumable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.putSession(session);
    // 首轮目标作为 Agent 会话的第一条用户消息落库（轨迹从这里开始）。
    await store.appendMessage(ready.sessionId, {
      id: newId('msg'),
      role: 'user',
      content: ready.goal,
      source: 'assistant',
      at: Date.now(),
    });
    await store.putExecutor({ ...ready, status: 'running' });

    const abort = new AbortController();
    this.executorAborts.set(ready.id, abort);
    // 每次派活都重置止损标记，避免上一次的状态污染本次。
    this.tokenGuardTripped = null;

    // 运行本身交给 runner（它只管跑，不管派活与汇报）。
    const { outcome, error } = await runExecutorOnce(
      this.runnerDeps({
        projectId: project.id,
        executorId: ready.id,
        skills,
        ...(project.tokenGuard ? { tokenGuard: project.tokenGuard } : {}),
        onAbort: () => abort.abort(),
      }),      project,
      ready,
      abort,
    );

    if (!outcome) {
      await this.finishExecutor(ready.id, 'failed', `Agent异常：${error ?? '未知错误'}`);
      this.gate.release(ready.id);
      this.executorAborts.delete(ready.id);
      return;
    }


    const final = store.getExecutor(ready.id);
    if (final && !isExecutorTerminal(final.status)) {
      const { kind } = classifyBlock(
        `${outcome.ok ? '' : (outcome.finalText || '')} ${outcome.events
          .filter((e) => e.type === 'error')
          .map((e) => (e.type === 'error' ? e.message : ''))
          .join(' ')}`,
      );
      if (outcome.ok) {
        // **独立复核**：D 说完成不算，先由系统自己验一遍。
        const acceptance = await this.runAcceptance(project, ready, () =>
          this.approveFor(project.id, ready.id, 'run_command', { command: 'acceptance-check' }),
        );
        const checked = store.getExecutor(ready.id);
        if (checked) {
          await store.putExecutor({ ...checked, acceptance });
        }

        if (acceptance?.verdict === 'failed') {
          // 复核失败 → 判失败，**不允许人工覆盖**。
          await this.finishExecutor(
            ready.id,
            'failed',
            `[卡点分类：需用户决定] 系统复核未通过：${acceptance.results
              .filter((r) => r.verdict === 'failed')
              .map((r) => `${r.criterion.desc}（${r.note}）`)
              .join('；')}`,
            outcome.finalText,
          );
        } else {
          await this.finishExecutor(ready.id, 'done', null, outcome.finalText);
        }
      } else if (this.tokenGuardTripped) {
        // 止损中止：原因要写清楚是"我们主动停的"，不是Agent自己失败。
        const reason = this.tokenGuardTripped;
        this.tokenGuardTripped = null;
        await this.finishExecutor(
          ready.id,
          'failed',
          `[卡点分类：需用户决定] 已按用量上限中止：${reason}。`,
          outcome.finalText,
        );
        await this.recordReport({
          projectId: project.id,
          executorId: ready.id,
          kind: 'blocked',
          body:
            `Agent「${ready.label}」已被用量上限中止：${reason}。\n` +
            `已消耗：轮次 ${outcome.metrics.turns}、步数 ${outcome.metrics.steps}、` +
            `token ${outcome.metrics.tokensIn + outcome.metrics.tokensOut}。\n` +
            '这是止损线，不是计费。要继续请调高上限。',
          needsUser: true,
        });
      } else {
        const reason = outcome.events.find((e) => e.type === 'error');
        const detail =
          reason && reason.type === 'error' ? reason.message : 'Agent没有给出结论';
        await this.finishExecutor(
          ready.id,
          'failed',
          `[卡点分类：${blockLabel(kind)}] ${detail}`,
          outcome.finalText,
        );
      }
    }

    this.gate.release(ready.id);
    this.executorAborts.delete(ready.id);

    // 把结论写进 Agent 的会话轨迹，用户点开这条对话时能看到完整过程。
    if (outcome.finalText.trim()) {
      await store.appendMessage(ready.sessionId, {
        id: newId('msg'),
        role: 'assistant',
        content: outcome.finalText,
        source: 'executor',
        at: Date.now(),
      });
    }
    const dSession = store.getSession(ready.sessionId);
    if (dSession) {
      await store.putSession({ ...dSession, status: 'idle', updatedAt: Date.now() });
    }

    // 先完成先汇报：这个 D 一结算就立刻交给 C，不等兄弟。
    const settled = store.getExecutor(ready.id)!;
    this.emit('runtime', {
      type: 'executor_settled',
      projectId: project.id,
      executor: settled,
      ok: settled.status === 'done',
    } as RuntimeEvent);

    await this.notifyAssistant(project, settled);
  }

  /**
   * 把结算结果交给 Assistant 并让它开口汇报。
   *
   * 这是"谁先完成先报谁"的关键：每个 D 结算时独立触发一次，
   * 互不等待。C 自己去决定措辞（它知道用户刚才说了什么）。
   */
  private async notifyAssistant(project: ProjectRow, executor: ExecutorRow): Promise<void> {
    const ok = executor.status === 'done';
    const body = ok
      ? `Agent「${executor.label}」已完成。\n${executor.summary ?? '（没有留下结论）'}`
      : `Agent「${executor.label}」未完成。\n${executor.blockedReason ?? '（无原因）'}\n${
          executor.summary ?? ''
        }`;

    await this.recordReport({
      projectId: project.id,
      executorId: executor.id,
      kind: ok ? 'done' : 'failed',
      body,
      // **不要写 `needsUser: !ok`**。
      //
      // 那样等于"Agent 没成功就要用户拍板"——可大多数失败能自己重试，
      // 或者换个做法就行。这行曾让待决策面板里 3/5 都是噪音。
      //
      // 要不要用户介入，交给 recordReport 里的判据按类型判：
      // 只有 blocked（卡住）才算。
      needsUser: false,
    });

    // 投给 Assistant：它会用 followup 语义处理（排到下一轮），然后向用户汇报。
    //
    // **internal=true**：这条是系统给 Assistant 的内部通知，不是用户说的话。
    // 它仍会进入 Assistant 的上下文（否则 Assistant 不知道结算了），但：
    // - 不进入对话流（界面上不显示成用户消息）；
    // - 界面上只显示 C 随后的自然回复。
    // 早期版本把整段结算 + "请立刻向用户汇报这一条结果" 都渲染进了对话，
    // 那是明确的泄漏。
    //
    // ## 用 Trigger 决定要不要唤醒（对齐 DSH）
    //
    // 完成和失败都**必须唤醒**（用户得知道结果）；取消是用户自己按的，
    // 不唤醒（省一次模型调用，也免得它反问"为什么取消"）。
    const trigger = makeTrigger(ok ? 'worker_report' : 'worker_failed', {
      text: `${INTERNAL_NOTICE_PREFIX}\n${body}\n\n请立刻向用户汇报这一条结果。`,
      executorId: executor.id,
    });

    if (!shouldWake(trigger)) {
      // 不唤醒：状态已经落库（recordReport），侧栏也会变，不需要 Assistant 说话。
      return;
    }

    try {
      await this.userSays(project.id, trigger.text!, {
        source: 'executor',
        internal: true,
      });
    } catch {
      // C 不在场也不丢事实：report 已落库。
    }
  }

  private async finishExecutor(
    id: string,
    status: 'done' | 'failed' | 'cancelled',
    blockedReason: string | null,
    summary?: string,
    /** 
     * 取消的来源。
     *
     * user：用户点了停止——要告诉 Assistant。
     * system：排队期间中止、止损等——调用方自己会说明原因，这里不重复发。
     */
    cancelledBy?: 'user' | 'system',
  ): Promise<void> {
    const row = this.store.getExecutor(id);
    if (!row) return;
    await this.store.putExecutor({
      ...row,
      status,
      blockedReason,
      summary: summary !== undefined ? summary : row.summary,
      endedAt: Date.now(),
    });
    const session = this.store.getSession(row.sessionId);
    if (session) {
      await this.store.putSession({ ...session, status: 'idle', updatedAt: Date.now() });
    }

    // **取消也要告诉 Assistant**。
    //
    // 不然它可能还在等这个 Agent 的结果，或者在下一轮里把"还在跑"当成事实。
    // 这个产品和 Codex 那类实现的一个明显差别就在这里：他们的子 Agent 被中断后
    // 结果不浮出来，父线程完全不知道发生了什么。
    //
    // 只报告"用户主动取消"这一种。排队期间中止（token 超限等）
    // 由调用方自己说清楚原因，不在这里重复。
    if (status === 'cancelled' && cancelledBy !== 'system') {
      await this.notifyCancelled(row);
    }

    // 方案推进：这个 Agent 如果是某一步的执行者，回填结果并决定下一步。
    //
    // **只对 done/failed 处理**：cancelled 是用户主动停的，
    // 不该算作"这一步失败"（那会让步子自己往前走到 blocked）。
    if (row.planStepId && (status === 'done' || status === 'failed')) {
      await this.advancePlan(row, status, summary ?? '');
    }
  }

  /**
   * 回填方案进度，并决定下一步。
   *
   * 关键取舍：**这里不直接派活**，而是发一条内部通知给 Assistant，
   * 让它照常决定下一步怎么做。理由：
   *   - 派活要考虑排队、写域冲突、用户新需求，这些都在 Assistant 那边
   *   - 由这里硬派会让 Assistant 对方案失去掌控，违反了"Assistant 是项目的主人"
   *
   * 所以方案推进的产物是「通知」+「状态更新」，不是直接的 spawn。
   */
  private async advancePlan(
    row: ExecutorRow,
    status: 'done' | 'failed',
    summary: string,
  ): Promise<void> {
    const plan = this.store.activePlanOf(row.projectId);
    if (!plan) return;
    if (!plan.steps.some((s) => s.id === row.planStepId)) return;

    const outcome =
      status === 'done'
        ? onStepDone(plan, row.planStepId!)
        : onStepFailed(plan, row.planStepId!);

    await this.store.putPlan(outcome.plan);

    const step = outcome.plan.steps.find((s) => s.id === row.planStepId);
    const lines: string[] = [];

    if (status === 'done') {
      lines.push(`方案步骤 ${row.planStepId}「${step?.title ?? ''}」已完成。`);
      const next = outcome.nextStepId;
      if (next) {
        const nextStep = outcome.plan.steps.find((s) => s.id === next);
        lines.push(
          `下一步是 ${next}「${nextStep?.title ?? ''}」。` +
            '方案已批准，**直接派活继续，不用再问用户**。',
        );
      } else if (outcome.plan.status === 'done') {
        lines.push('方案的全部步骤都完成了，向用户汇报最终结果。');
      } else {
        lines.push('当前没有可推进的步骤（后续步骤的依赖还没满足）。');
      }
    } else if (outcome.escalate) {
      lines.push(
        `方案步骤 ${row.planStepId}「${step?.title ?? ''}」已连续失败 ` +
          `${step?.attempts ?? 0} 次，方案卡住了。`,
        '把「哪一步、试过什么、卡在哪」讲清楚交给用户，不要自己再试。',
      );
    } else {
      const nextStep = outcome.plan.steps.find((s) => s.id === outcome.nextStepId);
      lines.push(
        `方案步骤 ${row.planStepId}「${step?.title ?? ''}」失败（第 ${step?.attempts ?? 1} 次）。`,
        `改法后重派：${nextStep?.title ?? ''}。` +
          '缩小范围或换做法，**不要重复同一个失败的做法**。',
      );
    }

    if (summary.trim()) {
      lines.push(`结算结论：${summary.slice(0, 400)}`);
    }

    const target = this.store.getProject(row.projectId);
    if (!target) return;

    // **计划进度变化不唤醒 Assistant**。
    //
    // 这类是"台账更新"，不是"用户需要被告知的事"。唤醒它会让模型
    // 为了"报一下进度"白跑一轮，而真正要说的话（Agent 结果、
    // 用户消息）反而被挤到后面。
    const planTrigger = makeTrigger('plan_advanced', {
      text: `${INTERNAL_NOTICE_PREFIX}\n${lines.join('\n')}`,
    });
    if (!shouldWake(planTrigger)) return;

    try {
      await this.userSays(target.id, planTrigger.text!, {
        source: 'executor',
        internal: true,
      });
    } catch {
      // Assistant 不在场不影响事实：方案状态已经落库
    }
  }

  /**
   * 告诉 Assistant 某个 Agent 被取消了。
   *
   * **只发事实，不催它立刻汇报**——用户自己按的停止，
   * 他知道发生了什么，Assistant 追着念一遍反而吵。
   * 但如果它下一轮要提这个 Agent，必须知道它已经停了。
   */
  private async notifyCancelled(row: ExecutorRow): Promise<void> {
    const project = this.store.getProject(row.projectId);
    if (!project) return;

    const body =
      `Agent「${row.label}」已被用户停止，没有跑完。\n` +
      (row.summary ? `它停之前完成的部分：${row.summary}` : '它没有留下阶段性结论。');

    // **取消不唤醒**：是用户自己按的停止键，不用再跟他说一遍。
    // 状态已经落库，侧栏会变。
    const cancelTrigger = makeTrigger('worker_cancelled', {
      text: `${INTERNAL_NOTICE_PREFIX}\n${body}`,
      executorId: row.id,
    });
    if (!shouldWake(cancelTrigger)) return;

    try {
      await this.userSays(project.id, cancelTrigger.text!, {
        source: 'executor',
        internal: true,
      });
    } catch {
      // Assistant 不在场也不影响事实：Agent 的状态已经落库
    }
  }

  /**
   * 用户在界面上点开某条 Agent 的对话，接着说一句。
   *
   * 这是"用户可直接和 D 对话"（方案 §3.3 / P3）。要点：
   * - D 带着**原有上下文**继续：把它的历史消息作为 priorMessages 传进去；
   * - 只读 D 仍然只读，写域限制也保持不变（不能借续聊越权）；
   * - 续聊产生的结论同样进 Agent 的会话轨迹，并通知 C（D3：Assistant 要知情）。
   */
  async userSaysToExecutor(
    executorId: string,
    text: string,
  ): Promise<{ ok: boolean; message: string }> {
    const row = this.store.getExecutor(executorId);
    if (!row) return { ok: false, message: `Agent ${executorId} 不存在` };
    if (row.status === 'starting' || row.status === 'running') {
      return {
        ok: false,
        message: '这个 Agent还在跑，请等它结束，或先取消它。',
      };
    }
    if (!text.trim()) return { ok: false, message: '内容不能为空' };

    const project = this.store.getProject(row.projectId);
    if (!project) return { ok: false, message: `项目 ${row.projectId} 不存在` };

    const session = this.store.getSession(row.sessionId);
    if (!session) return { ok: false, message: '找不到这个 Agent的会话记录，无法续聊' };

    // 记录用户这一句（作为这一轮的指令）。
    await this.store.appendMessage(row.sessionId, {
      id: newId('msg'),
      role: 'user',
      content: text,
      source: 'webapp',
      at: Date.now(),
    });

    // 取历史（不含本轮刚追加的这句，它会作为 goal 传入）。
    const prior = priorMessagesFrom(this.store, row.sessionId);

    await this.store.putExecutor({ ...row, status: 'running', endedAt: null, blockedReason: null });
    const abort = new AbortController();
    this.executorAborts.set(row.id, abort);

    const { outcome, error } = await resumeExecutorOnce(
      this.runnerDeps({ projectId: project.id, executorId: row.id }),
      {
        executor: row,
        project,
        text,
        priorMessages: prior,
        controller: abort,
      },
    );

    this.executorAborts.delete(row.id);

    if (!outcome) {
      await this.finishExecutor(row.id, 'failed', `续聊失败：${error ?? '未知错误'}`);
      return { ok: false, message: `续聊失败：${error ?? '未知错误'}` };
    }

    const ok = outcome.ok;
    await this.finishExecutor(
      row.id,
      ok ? 'done' : 'failed',
      ok ? null : `[卡点分类：${blockLabel(outcome.blockKind)}] ${outcome.finalText || '未给出结论'}`,
      outcome.finalText,
    );
    if (outcome.finalText.trim()) {
      await this.store.appendMessage(row.sessionId, {
        id: newId('msg'),
        role: 'assistant',
        content: outcome.finalText,
        source: 'executor',
        at: Date.now(),
      });
    }

    this.emit('runtime', {
      type: 'executor_settled',
      projectId: project.id,
      executor: this.store.getExecutor(row.id)!,
      ok,
    } as RuntimeEvent);

    // D3：C 必须知道用户直接跟 Agent 说的话，否则它的汇总会与事实不符。
    await this.recordReport({
      projectId: project.id,
      executorId: row.id,
      kind: ok ? 'progress' : 'failed',
      body: `用户直接对Agent「${row.label}」追问：「${text}」\n${outcome.finalText}`,
      needsUser: !ok,
    });

    return { ok, message: outcome.finalText || '（没有结论）' };
  }

  /** 读某个 Agent的完整轨迹（"打开原会话"）。 */
  executorTranscript(executorId: string): {
    executor: ExecutorRow | undefined;
    messages: ReturnType<Store['messages']>;
  } {
    const row = this.store.getExecutor(executorId);
    if (!row) return { executor: undefined, messages: [] };
    return { executor: row, messages: this.store.messages(row.sessionId) };
  }

  /** 取消一个 Agent。 */
  /**
   * 把一个项目移出工作区。
   *
   * ## 安全前提：有 Agent 在跑就不许移除
   *
   * 不是"顺手停掉"，而是**拒绝**。理由：
   * 用户点"移除"时可能没意识到有个 Agent 正在改文件。
   * 悄悄停掉它，等于把一个正在进行的破坏中途打断——
   * 那比直接拒绝更容易造成半截状态。
   *
   * 所以让用户先明确停掉，再移除。多做一步，但每一步都是他自己做的决定。
   *
   * ## 磁盘上的文件一个都不动
   *
   * 见 `Store.archiveProject` 的说明。
   */
  async removeProject(projectId: string): Promise<{ ok: boolean; message: string }> {
    const project = this.store.getProject(projectId);
    if (!project) return { ok: false, message: '项目不存在' };

    const running = this.store.listExecutors({
      projectId,
      status: ['running', 'starting'],
    });
    if (running.length > 0) {
      return {
        ok: false,
        message:
          `还有 ${running.length} 个 Agent 在跑，先把它们停掉再移除。` +
          '（不会自动停——正在改文件的任务被中途打断，容易留下半截状态）',
      };
    }

    // 落一个归档前的事实：以后想知道"这次改了什么"还能查
    this.emit('runtime', {
      type: 'project_removed',
      projectId,
      name: project.name,
      at: Date.now(),
    });

    await this.store.archiveProject(projectId);
    return {
      ok: true,
      message:
        `已把「${project.name}」移出工作区。磁盘上的文件没有动，` +
        '历史记录也都保留着——需要时可以重新打开同一个目录。',
    };
  }

  /**
   * 撤销一个文件写入。
   *
   * **只对文件写入有效**。跑过的命令撤不了、发出去的请求收不回，
   * 这些在界面上会明确标"不可撤销"，不给假承诺。
   *
   * 校验顺序很重要：
   * 1. 找副作用记录（不存在就没什么可撤）
   * 2. 判断类型能不能撤
   * 3. 比对"文件是否在之后又被改过"——**不符就拒绝**
   * 4. 执行恢复
   */
  async undo(
    sideEffectId: string,
    projectId?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const effects = this.store.listSideEffects({
      ...(projectId ? { projectId } : {}),
    });
    const effect = effects.find((e) => e.id === sideEffectId);
    if (!effect) return { ok: false, message: '找不到这条副作用记录' };

    if (!isUndoable(effect.kind, effect.reversible)) {
      return {
        ok: false,
        message:
          effect.reversible
            ? '这类动作无法撤销（只有文件写入可以）'
            : '这个动作本来就不可撤销，没有保留恢复数据',
      };
    }

    if (effect.state === 'undone') {
      return { ok: false, message: '这条已经撤销过了' };
    }

    const project = this.store.getProject(effect.projectId);
    if (!project) return { ok: false, message: '项目已不在工作区，无法撤销' };

    // 注意：**不传 expectedContent**。
    //
    // 台账里没有存"改完之后的内容"，所以查不出文件后来有没有被人改过。
    // 这个保护是重要的（见 docs/undo.md），但要有数据才能做——
    // 后续在 settle 时把结果内容一起记下来，才能启用这一层校验。
    const result = await undoFileWrite({
      snapshot: this.snapshots,
      rootPath: project.rootPath,
      sideEffectId,
      relativePath: effect.target,
    });

    if (result.ok) {
      // **不删台账**，改状态为 undone。
      // 和"重试不删历史"是同一个原则：事实不该被抹掉。
      await this.store
        .putSideEffect({ ...effect, state: 'undone', note: result.message, settledAt: Date.now() })
        .catch(() => {});
    }

    return { ok: result.ok, message: result.message };
  }

  /**
   * 取某个执行器的检查点列表。
   *
   * 检查点 = 时间窗内的一批文件改动，用于"整轮回滚"。
   * 不新开存储——台账里已经有 executorId 和 createdAt。
   */

  /** 联网搜索配置。apiKey 不在列表接口里回显。 */
  async searchSettings(): Promise<{ endpoint: string; configured: boolean }> {
    const s = await this.searchStore?.load().catch(() => null);
    return {
      endpoint: s?.endpoint ?? '',
      configured: s ? isSearchConfigured(s) : false,
    };
  }

  /** 保存联网搜索配置。 */
  async setSearchSettings(next: SearchSettings): Promise<{ ok: boolean; message: string }> {
    if (!this.searchStore) {
      return { ok: false, message: '这个版本没有接入联网搜索配置' };
    }
    await this.searchStore.save({
      endpoint: next.endpoint.trim(),
      apiKey: next.apiKey.trim(),
    });
    // 立刻刷新缓存，不用重启就生效
    await this.refreshSearchCache();
    return {
      ok: true,
      message: isSearchConfigured(next) ? '已保存，联网搜索可用。' : '已保存。endpoint 和密钥都填了才能用。',
    };
  }

  /** 应用图标配色。 */
  async iconTheme(): Promise<string> {
    if (!this.iconThemeStore) return DEFAULT_ICON_THEME;
    return this.iconThemeStore.load();
  }

  /** 保存图标配色。空值/非法值一律归一成默认。 */
  async setIconTheme(theme: string): Promise<{ ok: boolean; theme: string }> {
    const next = normalizeIconTheme(theme);
    if (this.iconThemeStore) await this.iconThemeStore.save(next);
    return { ok: true, theme: next };
  }

  /** 给执行器用的搜索配置（没配置时返回 null）。 */
  async searchConfig(): Promise<{ endpoint: string; apiKey: string } | null> {
    const s = await this.searchStore?.load().catch(() => null);
    if (!s || !isSearchConfigured(s)) return null;
    return { endpoint: s.endpoint, apiKey: s.apiKey };
  }


  /**
   * 刷新搜索配置缓存。
   *
   * 启动时调一次；每次保存配置后再调一次。
   * 这样同步的 runnerDeps 也能拿到最新配置。
   */
  async refreshSearchCache(): Promise<void> {
    this.searchCache = await this.searchConfig();
  }
  checkpointsForExecutor(executorId: string, projectId?: string): Checkpoint[] {
    const rows = this.store.listSideEffects({
      ...(projectId ? { projectId } : {}),
    });
    return buildCheckpoints(rows, { executorId });
  }

  /**
   * 回滚一个检查点：把这一轮改过的文件整批恢复。
   *
   * **不覆盖用户后来手工改过的文件**——那个保护在 rollbackCheckpoint 里。
   */
  async rollbackCheckpoint(input: {
    executorId: string;
    checkpointId: string;
    projectId?: string;
  }): Promise<{ ok: boolean; message: string; restored: string[]; skipped: { path: string; reason: string }[] }> {
    const rows = this.store.listSideEffects({
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    const list = buildCheckpoints(rows, { executorId: input.executorId });
    const cp = list.find((x) => x.id === input.checkpointId);
    if (!cp) return { ok: false, message: '找不到这个检查点', restored: [], skipped: [] };

    const first = rows.find((r) => r.executorId === input.executorId);
    if (!first) return { ok: false, message: '找不到这个执行器的记录', restored: [], skipped: [] };
    const project = this.store.getProject(first.projectId);
    if (!project) return { ok: false, message: '项目已不在工作区，无法回滚', restored: [], skipped: [] };

    const outcome = await rollbackCheckpoint({
      snapshot: this.snapshots,
      rootPath: project.rootPath,
      rows,
      checkpoint: cp,
    });

    for (const file of outcome.restored) {
      const hit = rows.find(
        (r) =>
          r.executorId === input.executorId &&
          r.kind === 'fs.write' &&
          r.target === file &&
          r.createdAt >= cp.from &&
          r.createdAt <= cp.to &&
          r.state === 'succeeded',
      );
      if (hit) {
        await this.store.putSideEffect({ ...hit, state: 'undone', note: outcome.message, settledAt: Date.now() });
      }
    }

    return {
      ok: outcome.restored.length > 0,
      message: outcome.message,
      restored: [...outcome.restored],
      skipped: outcome.skipped.map((s) => ({ ...s })),
    };
  }

  /**
   * 用户叫停：停掉这个项目里**一切正在进行的事**。
   *
   * ## 为什么不是"只停 Assistant"
   *
   * 「连发不打断」是**故意的设计**：用户不需要打断 Assistant，只说最新的想法，
   * 消息排队，当前这轮跑完再被看到。所以用户嘴里的"停"，从来不是让 Assistant 闭嘴。
   *
   * 它指的是：**什么活都别干了。** 那意味着 Assistant 当前这轮停掉，
   * 而且它派出去的 Agent 一个都不许继续改文件、继续烧 token。
   *
   * ## 曾经的真缺陷
   *
   * HTTP 的 `/stop` 只调了 `assistant.stop()`，一个 Agent 都没停。
   * 用户点了停止，Agent 还在跑，而且界面没有任何异常——这是最坏的一种：
   * 看起来停了，实际在花钱。
   *
   * ## 排队的也要取消
   *
   * 否则上限释放后，排队的 Agent 会自己开跑——
   * 用户叫停之后又被"自己停止前派出去的活"接着干，比不停更令人意外。
   *
   * 取消一律走 `cancel()`：它负责中止、结算、释放写域闸门，
   * 并且把状态记成 `cancelled` 而不是 `done`——**任务没做完，不许记成完成**。
   */
  async stopAll(projectId: string): Promise<{ cancelled: string[]; failed: string[] }> {
    // 先停 Assistant：否则它还在跑的这一轮可能继续 spawn 新的 Agent。
    this.getAssistant(projectId)?.stop();

    const live = this.store
      .listExecutors({ projectId })
      .filter((row) => !isExecutorTerminal(row.status));

    const cancelled: string[] = [];
    const failed: string[] = [];
    for (const row of live) {
      const result = await this.cancel(row.id, projectId);
      if (result.ok) cancelled.push(row.id);
      else failed.push(row.id);
    }
    return { cancelled, failed };
  }

  async cancel(executorId: string, projectId?: string): Promise<{ ok: boolean; content: string }> {
    const row = this.store.getExecutor(executorId);
    if (!row) return { ok: false, content: `Agent ${executorId} 不存在` };
    if (projectId && row.projectId !== projectId) {
      return { ok: false, content: `Agent ${executorId} 不属于本项目` };
    }
    if (isExecutorTerminal(row.status)) {
      return { ok: false, content: `Agent ${executorId} 已是终态 ${row.status}，无需取消` };
    }

    this.executorAborts.get(executorId)?.abort();
    await this.finishExecutor(executorId, 'cancelled', null, undefined, 'user');
    this.gate.release(executorId);
    return { ok: true, content: `Agent ${executorId} 已取消` };
  }

  private async recordReport(input: {
    projectId: string;
    executorId: string | null;
    kind: 'progress' | 'blocked' | 'done' | 'failed' | 'question';
    body: string;
    needsUser: boolean;
  }): Promise<ReportRow> {
    const report: ReportRow = {
      id: newId('rpt'),
      projectId: input.projectId,
      executorId: input.executorId,
      kind: input.kind,
      body: input.body.slice(0, 8000),
      // **统一在这里过一遍判据**。
      //
      // 之前每个调用点自己决定 needsUser，结果 `needsUser: !ok`
      // 把"Agent 没成功"也标成了待决策——界面上 5 条有 3 条是噪音。
      //
      // 规则：
      // - 调用方说"要"（true）→ 尊重
      // - 调用方说"不要"（false）→ 也尊重，但只对 blocked 类放宽：
      //   blocked 本身就该问用户，调用方写 false 多半是没想清楚
      // - 没表态 → 交给判据按类型判
      needsUser: needsUserDecision({
        kind: input.kind,
        body: input.body,
        ...(input.needsUser ? { explicit: true } : {}),
      }),
      at: Date.now(),
      ackedAt: null,
    };
    await this.store.putReport(report);
    this.emit('runtime', { type: 'report', projectId: input.projectId, report } as RuntimeEvent);
    return report;
  }

  /**
   * 全局使用报告。
   *
   * 回答"我自己是怎么用这个产品的"——派了多少、成功率多少、
   * 哪类失败最多、哪些项目冷掉了。
   *
   * **只统计，不评价**；**全在本地算，不上报**。
   */
  buildUsageReport(days = 30): UsageStats {
    const since = Date.now() - days * 86_400_000;

    const executors = this.store.listProjects().flatMap((project) =>
      this.store.listExecutors({ projectId: project.id }).map((e) => ({
        status: e.status,
        label: e.label,
        createdAt: e.createdAt,
        blockedReason: e.blockedReason,
      })),
    );

    const effects = this.store.listProjects().flatMap((project) =>
      this.store.listSideEffects({ projectId: project.id }).map((e) => ({
        tool: e.tool,
        target: e.target,
        state: e.state,
        createdAt: e.createdAt,
      })),
    );

    const projects = this.store.listProjects().map((p) => {
      // 最后活动时间取该项目下最新的任务创建时间
      const mine = this.store.listExecutors({ projectId: p.id });
      const last = mine.reduce((max, e) => Math.max(max, e.createdAt), p.createdAt);
      return { name: p.name, lastActivityAt: last };
    });

    void since;
    return buildUsageReport({ days, executors, effects, projects });
  }

  /**
   * 告诉 Assistant：新派的 Agent 和正在跑的撞了写域，已经排队。
   *
   * **只报事实，不指挥它怎么做**。它可能想等、想改派、想换个做法——
   * 那是它的判断。系统只保证它**知道这件事**。
   *
   * 为什么需要这条：写域互斥只在真的创建了两个 Agent 时才生效。
   * 如果 Assistant 判断失误派重了，系统会排队，但之前**不会告警**——
   * 表现为"任务莫名很慢"，而没人知道原因。
   */
  private async notifyWriteConflict(
    project: ProjectRow,
    waiting: ExecutorRow,
    conflict: { withTaskId?: string; reason?: string },
  ): Promise<void> {
    const blocking = conflict.withTaskId ? this.store.getExecutor(conflict.withTaskId) : undefined;

    const body =
      `新派的 Agent「${waiting.label}」和正在跑的` +
      (blocking ? `「${blocking.label}」` : '另一个 Agent') +
      '撞了写域，已排队等它跑完。\n' +
      `原因：${conflict.reason ?? '写域冲突'}`;

    const conflictTrigger = makeTrigger('write_conflict', {
      text:
        `${INTERNAL_NOTICE_PREFIX}\n${body}\n\n` +
        '这不一定需要处理。但如果两件事本来就该并行，考虑换个做法（比如合并成一个任务，或者声明不同的写域）。',
      executorId: waiting.id,
    });
    // **写域冲突不唤醒**：它是"你可能想换个做法"的提示，
    // 不需要模型立刻去做什么。侧栏和待决策面板会显示。
    if (!shouldWake(conflictTrigger)) return;

    await this.userSays(project.id, conflictTrigger.text!, {
      source: 'executor',
      internal: true,
    });
  }

  /**
   * 把一条待决策标记为已处理。
   *
   * **不删除、不隐藏**——用户可能要回头查"当时我是怎么决定的"。
   * 只是从"等你决定"的待办里移走。
   *
   * 这是决策级介入的唯一出口：除了这里和危险动作审批，
   * 其它任何地方都不该打断用户。
   */
  async acknowledgeReport(reportId: string): Promise<{ ok: boolean; message: string }> {
    const report = this.store.getReport(reportId);
    if (!report) return { ok: false, message: '找不到这条汇报' };
    if (report.ackedAt !== null) return { ok: true, message: '这条已经处理过了' };

    const updated: ReportRow = { ...report, ackedAt: Date.now() };
    await this.store.putReport(updated);
    this.emit('runtime', {
      type: 'report',
      projectId: report.projectId,
      report: updated,
    } as RuntimeEvent);

    return { ok: true, message: '已标记为处理' };
  }

  /**
   * 提炼候选记忆。
   *
   * **候选不生效**：它们只是躺在候选表里等你过一眼。
   * 这是自动记忆的安全阀——LLM 判断"值得记"不等于真的值得记。
   */
  async extractMemoryCandidates(projectId: string): Promise<{
    created: number;
    rejected: number;
  }> {
    if (!this.memory) return { created: 0, rejected: 0 };
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目 ${projectId} 不存在`);

    // 用最近一段对话当素材。
    const transcript = this.store.messages(project.assistantSessionId).slice(-40);

    const scope: MemoryScope = { kind: 'project', projectKey: project.rootPath };
    const existing = [
      ...(await this.memory.list(scope)).map((e) => e.text),
      ...(await this.memory.list({ kind: 'global' })).map((e) => e.text),
    ];
    // 用户已经拒绝过的，不再提。
    const dismissed = this.store
      .listCandidates({ projectId, status: ['dismissed'] })
      .map((c) => c.text);

    const controller = new AbortController();
    const result = await extractCandidates({
      llm: this.llm,
      transcript,
      existing,
      dismissed,
      signal: controller.signal,
    });

    for (const candidate of result.candidates) {
      await this.store.putCandidate({
        id: newId('memc'),
        projectId,
        kind: candidate.kind,
        scope: candidate.scope,
        text: candidate.text,
        source: `自动提炼 · ${new Date().toISOString().slice(0, 10)}`,
        status: 'pending',
        createdAt: Date.now(),
        decidedAt: null,
      });
    }

    this.emit('runtime', {
      type: 'memory_candidates',
      projectId,
      created: result.candidates.length,
    } as RuntimeEvent);

    return { created: result.candidates.length, rejected: result.rejected.length };
  }

  /** 采纳一条候选：真正写进记忆文件。 */
  async acceptMemoryCandidate(
    candidateId: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!this.memory) return { ok: false, message: '未启用记忆功能' };
    const row = this.store.getCandidate(candidateId);
    if (!row) return { ok: false, message: `候选 ${candidateId} 不存在` };
    if (row.status !== 'pending') {
      return { ok: false, message: `该候选已是 ${row.status}` };
    }

    const project = this.store.getProject(row.projectId);
    if (!project) return { ok: false, message: '项目不存在' };

    const scope: MemoryScope =
      row.scope === 'global'
        ? { kind: 'global' }
        : { kind: 'project', projectKey: project.rootPath };

    const written = await this.memory.write(scope, {
      kind: row.kind,
      text: row.text,
      source: row.source,
    });
    if (!written.ok) {
      return { ok: false, message: written.reason ?? '写入失败' };
    }

    await this.store.putCandidate({
      ...row,
      status: 'accepted',
      decidedAt: Date.now(),
    });
    return { ok: true, message: '已写入记忆' };
  }

  /** 忽略一条候选。被忽略的内容以后不再自动提出。 */
  async dismissMemoryCandidate(id: string): Promise<{ ok: boolean; message: string }> {
    const row = this.store.getCandidate(id);
    if (!row) return { ok: false, message: `候选 ${id} 不存在` };
    if (row.status !== 'pending') return { ok: false, message: `该候选已是 ${row.status}` };
    await this.store.putCandidate({ ...row, status: 'dismissed', decidedAt: Date.now() });
    return { ok: true, message: '已忽略，之后不会再提出同样的内容' };
  }

  /** 读某个项目的待审候选。 */
  listMemoryCandidates(projectId: string): ReturnType<Store['listCandidates']> {
    return this.store.listCandidates({ projectId });
  }

  /**
   * 已生效的记忆（全局 + 项目）。
   *
   * 用户需要能看见"它到底记住了什么"，否则不敢放心让它自己记。
   */
  async listMemories(projectId: string): Promise<{
    global: Array<{ id: string; kind: string; text: string; source: string }>;
    project: Array<{ id: string; kind: string; text: string; source: string }>;
  }> {
    if (!this.memory) return { global: [], project: [] };
    const projectRow = this.store.getProject(projectId);
    if (!projectRow) throw new Error(`项目 ${projectId} 不存在`);

    const strip = (entries: Awaited<ReturnType<MarkdownMemoryStore['list']>>) =>
      entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text, source: e.source }));

    return {
      global: strip(await this.memory.list({ kind: 'global' })),
      project: strip(await this.memory.list({ kind: 'project', projectKey: projectRow.rootPath })),
    };
  }

  /** 删掉一条已生效的记忆。用户可以反悔。 */
  async forgetMemory(
    projectId: string,
    scope: 'global' | 'project',
    entryId: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (!this.memory) return { ok: false, message: '未启用记忆功能' };
    const projectRow = this.store.getProject(projectId);
    if (!projectRow) return { ok: false, message: '项目不存在' };

    const target: MemoryScope =
      scope === 'global' ? { kind: 'global' } : { kind: 'project', projectKey: projectRow.rootPath };
    const removed = await this.memory.remove(target, entryId);
    return removed
      ? { ok: true, message: '已删除' }
      : { ok: false, message: `找不到记忆 ${entryId}` };
  }

  /** 可见状态，供 UI 与测试读取。 */
  stats(): { running: number; queued: number; limit: number } {
    return this.gate.stats();
  }

  /**
   * 删除一条会话（Agent）。
   *
   * 拒绝删除正在跑的：那会让执行到一半的写入停在半路，
   * 而且用户会以为"删了就没事了"。要删就先停。
   */
  async deleteExecutor(executorId: string): Promise<void> {
    const executor = this.store.getExecutor(executorId);
    if (!executor) throw new Error(`Agent ${executorId} 不存在`);

    if (executor.status === 'running' || executor.status === 'starting') {
      throw new Error('这条会话正在运行，请先停止再删除');
    }

    // 清掉它的中断句柄与输入队列，避免之后还被引用
    this.executorAborts.delete(executorId);
    this.executorInputs.delete(executorId);
    await this.store.deleteExecutor(executorId);
  }

  /**
   * 扫描某个项目可用的技能。
   *
   * 两个来源，**项目级覆盖用户级**：
   * - `<项目>/.opencoxswain/skills/` —— 这个项目自己的约定
   * - `~/.opencoxswain/skills/` —— 跨项目通用的习惯
   *
   * 每次派活时扫一次（技能文件很小，读目录开销可以忽略），
   * 好处是改了技能文件立刻生效，不用重启。
   */
  async skillsFor(project: ProjectRow): Promise<SkillSummary[]> {
    const [projectSkills, userSkills] = await Promise.all([
      scanSkillRoot(path.join(project.rootPath, '.opencoxswain', 'skills'), 'project'),
      scanSkillRoot(this.userSkillsDir, 'user'),
    ]);
    return mergeSkills([projectSkills, userSkills]);
  }

  // -------------------------------------------------------------------------
  // 关闭行为
  // -------------------------------------------------------------------------

  /** 有多少 Agent 正在跑（决定关闭时要不要提醒）。 */
  runningAgents(): number {
    let count = 0;
    for (const project of this.store.listProjects()) {
      for (const agent of this.store.listExecutors({ projectId: project.id })) {
        if (agent.status === 'running' || agent.status === 'starting') count += 1;
      }
    }
    return count;
  }

  /** 多模型配置。 */
  async modelSettings(): Promise<ModelSettings> {
    return this.modelStore.load();
  }

  /** 保存多模型配置（校验在调用方做）。 */
  async saveModelSettings(settings: ModelSettings): Promise<void> {
    await this.modelStore.save(settings);
  }

  /** 密钥存储形态，界面要如实显示。 */
  modelStorageMode(): 'encrypted' | 'plaintext' {
    return this.modelStore.storageMode();
  }

  /**
   * 权限设置。
   *
   * @param projectId 传项目 id 时额外返回这个项目**实际生效**的档位。
   */
  async permissionSettings(
    projectId?: string | null,
  ): Promise<{ level: PermissionLevel; projects: Readonly<Record<string, PermissionLevel>>; effective: PermissionLevel }> {
    const s = await this.permissionStore.load();
    return {
      level: s.level,
      projects: s.projects,
      effective: levelForProject(s, projectId),
    };
  }

  /**
   * 改权限档位（立即生效）。
   *
   * **按项目隔离**：传 projectId 只改那个项目，其他项目不受影响；
   * 不传则改全局默认（新项目的初始值）。
   */
  async setPermissionLevel(level: PermissionLevel, projectId?: string | null): Promise<void> {
    const s = await this.permissionStore.load();
    if (!projectId) {
      await this.permissionStore.save({ level, projects: s.projects });
      return;
    }
    await this.permissionStore.save({
      level: s.level,
      projects: { ...s.projects, [projectId]: level },
    });
  }

  /** 当前**生效**的权限档位（按项目解析）。 */
  effectivePermission(projectId?: string | null): Promise<PermissionLevel> {
    return this.permissionStore.load().then((s) => levelForProject(s, projectId));
  }

  /**
   * 权限策略的同步快照 + 版本号。
   *
   * ## 为什么需要同步版本
   *
   * `spawn` 里要生成授权快照（Mandate），而它需要**当前**档位和版本。
   * `effectivePermission` 是 async 的，在 `spawn` 里 await 一次可以，
   * 但版本号得有个稳定的来源。
   *
   * 做法：每次权限变更时把版本号 +1，存进内存。
   * **进程重启后版本号归零**——这不是问题：重启后所有工单都已结算，
   * 没有"在途工单需要重新校验"的场景。
   */
  private permissionVersion = 1;

  /** 当前权限策略版本（用于授权快照和重新校验）。 */
  permissionPolicyVersion(): number {
    return this.permissionVersion;
  }

  /** 权限变更后调用：推进版本号，让在途工单恢复时能发现策略变了。 */
  bumpPermissionVersion(): void {
    this.permissionVersion += 1;
  }

  async closeSettings(): Promise<CloseSettings> {
    return this.closeStore.load();
  }

  async setCloseSettings(settings: CloseSettings): Promise<void> {
    await this.closeStore.save(settings);
  }

  /**
   * 关闭前的检查。
   *
   * 选「退出」且有 Agent 在跑 → 必须确认。
   * 判断放在这里而不是界面，保证壳和界面用同一套规则。
   */
  async checkClose(): Promise<{
    action: CloseAction;
    running: number;
    confirm: boolean;
    message: string;
  }> {
    const settings = await this.closeStore.load();
    const running = this.runningAgents();
    const verdict = shouldConfirmQuit(settings.closeAction, running);
    return {
      action: settings.closeAction,
      running,
      confirm: verdict.confirm,
      message: verdict.message,
    };
  }

  // -------------------------------------------------------------------------
  // Supervisor（跨项目能力）
  // -------------------------------------------------------------------------

  /**
   * 全局视图：所有项目的状态汇总。
   *
   * 这是 General Manager 的核心能力——Project Manager 只看得到自己那一个。
   */
  globalOverview(): GlobalOverview {
    return buildGlobalOverview(this.store);
  }

  /** 优先级裁决：多个项目都在等用户时，谁该先处理。 */
  priorities(): readonly ProjectOverview[] {
    return prioritize(this.globalOverview());
  }

  /** 按人类可读的方式描述全局状态。 */
  describeGlobal(): string {
    return describeOverview(this.globalOverview());
  }

  // -------------------------------------------------------------------------
  // 模板与定时（都只产出"待确认"，不自动开工）
  // -------------------------------------------------------------------------

  /** 列出内置任务模板。 */
  listTemplates(): readonly TaskTemplate[] {
    return TEMPLATES;
  }

  /**
   * 套用模板 → 待确认的派活草稿。
   *
   * **不会派活。** 调用方必须让用户确认后再调 `spawn`。
   */
  applyTemplate(id: string, input: { label: string; goal: string }): AppliedTemplate {
    const template = findTemplate(id);
    if (!template) throw new Error(`模板 ${id} 不存在`);
    return applyTemplate(template, input);
  }

  /**
   * 检查定时并产出建议。
   *
   * **只产出建议，不派活。** 整个模块没有"自动执行"的入口。
   */
  async checkSchedules(now = Date.now()): Promise<Suggestion[]> {
    const schedules = await this.scheduleStore.load();
    const fired = await checkSchedules(schedules, (spec) => this.scheduleStore.save(spec), now);
    for (const suggestion of fired) {
      await this.recordReport({
        projectId: suggestion.projectId,
        executorId: null,
        kind: 'progress',
        body:
          `⏰ 定时提醒：${suggestion.title}\n\n${suggestion.goal}\n\n` +
          '（这只是提醒，还没有派活。确认后才会开始。）',
        needsUser: true,
      });

      // **定时提醒要唤醒 Assistant**。
      //
      // 原来只落进待决策面板，用户得自己想起来去看。而定时任务的意义
      // 恰恰是"到点了提醒我"——不告诉用户等于没提醒。
      //
      // 注意：**仍然只提醒，不派活**（模板和定时都不自动执行）。
      const trigger = makeTrigger('schedule_fired', {
        text:
          `${INTERNAL_NOTICE_PREFIX}\n` +
          `定时「${suggestion.title}」到点了：\n${suggestion.goal}\n\n` +
          '请提醒用户，并说明这只是提醒、还没派活。**不要直接派 Agent**，' +
          '等用户确认后再说。',
      });
      if (shouldWake(trigger)) {
        try {
          await this.userSays(suggestion.projectId, trigger.text!, {
            source: 'schedule',
            internal: true,
          });
        } catch {
          // Assistant 不在场也不丢事实：report 已落库
        }
      }
    }
    return fired;
  }

  /** 创建/更新一条定时。 */
  async saveSchedule(spec: ScheduleSpec): Promise<void> {
    await this.scheduleStore.save(spec);
  }

  /** 列出定时。 */
  async listSchedules(projectId?: string): Promise<readonly ScheduleSpec[]> {
    const all = await this.scheduleStore.load();
    return projectId ? all.filter((s) => s.projectId === projectId) : all;
  }

  /**
   * 重启恢复（D5：关掉软件后完整恢复）。
   *
   * 两件事：
   * 1. 上次进程被中断时仍在跑的Agent → 如实标记为失败。
   *    子代理随进程一起死了，`running` 是上一世的记忆，不承认它继续有效。
   *    **不能**悄悄改回队列自动重跑：那会在用户不知情的情况下重复执行副作用。
   * 2. 项目与 Assistant 的会话历史本来就在库里，这里只是把句柄重新挂上，
   *    下一次用户说话时 Assistant 会带着原上下文继续。
   *
   * 幂等：可以重复调用。
   */
  async recover(): Promise<RecoveryReport> {
    const interrupted: ExecutorRow[] = [];
    for (const row of this.store.listExecutors({ status: ['starting', 'running'] })) {
      const updated: ExecutorRow = {
        ...row,
        status: 'failed',
        blockedReason:
          '[卡点分类：需用户决定] 上次执行被中断（软件已关闭），需要重新派活才能继续。',
        endedAt: Date.now(),
      };
      await this.store.putExecutor(updated);
      interrupted.push(updated);
    }

    const recoveredProjects: RecoveryReport['recoveredProjects'] = [];
    for (const project of this.store.listProjects()) {
      if (this.store.getSession(project.assistantSessionId)) {
        recoveredProjects.push({
          projectId: project.id,
          name: project.name,
          assistantSessionId: project.assistantSessionId,
        });
      }
    }

    // 重启后不可能还有人在等旧审批：全部置为过期。
    // 否则界面会显示一堆"待审批"，但它们对应的Agent早就没了。
    const staleApprovals = await expireStaleApprovals(this.store);

    return {
      interruptedExecutors: interrupted,
      recoveredProjects,
      expiredApprovals: staleApprovals.length,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const abort of this.executorAborts.values()) abort.abort();
    this.executorAborts.clear();
    for (const assistant of this.assistants.values()) assistant.stop();
    this.assistants.clear();
    this.gate.reset();
    await this.store.close();
  }
}

/**
 * 内部通知的标记前缀。
 *
 * 用于两件事：
 * 1. 让 Assistant 在上下文里分辨"这是系统通知"而不是用户说的话；
 * 2. 界面与历史查询据此把它和真实用户消息区分开。
 */
export const INTERNAL_NOTICE_PREFIX = '【Agent结算】';

function labelOf(judged: TurnJudgment): string {
  return judged === 'new' ? '新增' : judged === 'parallel' ? '并列' : '冲突';
}

function blockLabel(kind: BlockKind): string {
  return kind === 'self-recoverable' ? '可自行重试' : kind === 'environment' ? '环境问题' : '需用户决定';
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? text;
}

/** 工具参数摘要，用于轨迹里显示"它跑了什么"。 */
function truncateArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      return `${k}=${short}`;
    });
  return entries.join(' ') || '（无参数）';
}

function lastSegment(normalized: string): string {
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { Inbox };
