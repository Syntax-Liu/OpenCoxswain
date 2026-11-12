/**
 * 编排核心：把 C 与 D 连起来。
 *
 * 这个文件实现用户设想里最关键的几条：
 *
 * | 用户要求 | 这里怎么实现 |
 * | --- | --- |
 * | 用户对 C 说话，C 立刻回复 | `say()` 同步入队，不等模型 |
 * | 连发不打断 | 消息进 Inbox，跑到步边界才被看到 |
 * | C 调多个 D 并行 | `spawn()` 立刻返回，D 在后台跑 |
 * | 谁先完成先汇报谁 | 每个 D 独立结算、独立回调，不等兄弟 |
 * | 写域互斥兜底 | `Gate` 在派发时排队 |
 * | C 主动推进 | 卡点分类 + 可继续使用的 message 通道 |
 *
 * 这里**不写 UI、不写 HTTP**：运行时只产生事件，上层（daemon / 桌面壳）
 * 决定怎么展示。
 */
import { EventEmitter } from 'node:events';

import { Gate, normalizeWriteScopes, parseScopeClaim, type ScopeClaim } from './executor/gate.js';
import { classifyBlock, executorSystemPrompt, type BlockKind, type ExecutorToolHostOptions } from './executor/executor.js';
import { runExecutorOnce, resumeExecutorOnce, priorMessagesFrom, type ExecutorRunnerDeps } from './executor/runner.js';
import { runLoop, type LoopEvent, type ToolHost } from './session/loop.js';
import { assistantSystemPrompt, assistantTools } from './assistant/prompt.js';
import { judgeConflict, AssistantSession } from './assistant/session.js';
import type { MarkdownMemoryStore, MemoryScope } from './memory/store.js';
import { extractCandidates } from './memory/extract.js';
import { TEMPLATES, applyTemplate, findTemplate, type AppliedTemplate, type TaskTemplate } from './templates/templates.js';
import { checkSchedules, type ScheduleSpec, type Suggestion } from './schedules/schedules.js';
import { MemoryScheduleStore, type ScheduleStorage } from './schedules/store.js';
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

export interface OrchestratorOptions {
  readonly store: Store;
  readonly llm: LlmClient;
  readonly maxConcurrentExecutors?: number;
  readonly maxStepsPerExecutor?: number;
  readonly commandTimeoutMs?: number;
  /** 项目记忆读取器；返回空串表示没有。 */
  readonly readMemory?: (project: ProjectRow) => Promise<string>;
  /**
   * 记忆存储。提供后，C 会得到 remember / search_memory 两个工具，
   * 且每次开轮时按当前消息检索相关记忆注入系统提示。
   */
  readonly memory?: MarkdownMemoryStore;
  /** 危险动作审批的超时（毫秒）。默认 10 分钟，到点自动拒绝。 */
  readonly approvalTimeoutMs?: number;
  /** 定时配置存储；不提供时定时功能不可用。 */
  readonly schedules?: ScheduleStorage;
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
   * 验收标准。C 派活时声明"怎么算做完了"。
   *
   * 不声明也能派，但那样就只能靠人看结论——**没有任何自动复核**。
   */
  readonly criteria?: readonly Criterion[];
  /** 验收策略，默认 unverified_only。 */
  readonly policy?: AcceptancePolicy;
}

export interface SpawnResult {
  readonly executor: ExecutorRow;
  readonly admitted: boolean;
  readonly queueReason: string;
  readonly judgmentNote: string;
}

/** 重启恢复结果，供启动时日志与 UI 展示。 */
export interface RecoveryReport {
  /** 上次运行中被中断、已被如实标记为失败的执行者。 */
  readonly interruptedExecutors: ExecutorRow[];
  /** 可从历史恢复的项目与它们的 C 会话。 */
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

  /** 每个项目的 C 会话（内存句柄；历史在 store 里）。 */
  private readonly assistants = new Map<string, AssistantSession>();
  /** D 的中途输入通道：executorId → 待注入文本。 */
  private readonly executorInputs = new Map<string, string[]>();
  /** D 的中止控制器。 */
  private readonly executorAborts = new Map<string, AbortController>();
  /** 本次运行中止是否由用量止损触发（用于写准确的失败原因）。 */
  private tokenGuardTripped: string | null = null;
  /** 审批超时（毫秒）。到点自动拒绝，不让执行者无限挂起。 */
  private readonly approvalTimeoutMs: number | undefined;
  private readonly scheduleStore: ScheduleStorage;
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
   * 用户对 C 说一句。**立刻返回**。
   *
   * 如果 C 当前空闲，会在后台立刻开始一轮；如果正在跑，
   * 这条消息就排在 inbox 里等下一个边界（不打断）。
   *
   * `internal=true` 表示这是**系统内部的投递**（如执行者结算通知），
   * 不是用户说的话：它会进入 C 的上下文，但不应出现在对话流里。
   */
  async userSays(
    projectId: string,
    text: string,
    options: { source?: string; target?: 'next' | 'step'; internal?: boolean } = {},
  ): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目 ${projectId} 不存在`);
    const assistant = await this.ensureAssistant(project);

    assistant.say(text, {
      ...(options.source ? { source: options.source } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.internal ? { internal: true } : {}),
    });

    // 不 await：C 在后台自己跑，用户随时可以继续发。
    void this.pumpAssistant(project).catch((error: unknown) => {
      this.emit('runtime', {
        type: 'assistant_text',
        projectId,
        text: `项目助理执行出错：${errorText(error)}`,
      });
    });
  }

  /** C 的主循环：有排队消息且当前空闲就跑一轮。 */
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
  ): Promise<void> {
    const inputs = assistant.inbox.drainForStep();
    for (const item of inputs) {
      await assistant.recordUser(item.text, item.source, item.internal);
    }

    // 用一个"只消费一轮"的 drain：本轮开头已取走全部消息。
    const messages = assistant.history();
    // 记忆注入：拿这一轮**用户真正说的话**去检索。
    // 内部通知（结算等）里含执行者的原始输出，用它检索会召回无关记忆。
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
          text: `（项目助理出错：${event.message}）`,
        } as RuntimeEvent);
      }
    }

    await assistant.recordAssistant(finalText);
  }

  /** C 的工具执行宿主。 */
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
              });
              return {
                ok: true,
                content: [
                  `已派出执行者「${result.executor.label}」（${result.executor.id}），状态 ${result.executor.status}。`,
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
                return { ok: false, content: `执行者 ${id} 不属于本项目` };
              }
              if (isExecutorTerminal(row.status)) {
                return { ok: false, content: `执行者 ${id} 已结束（${row.status}），无法接收指令` };
              }
              const queue = this.executorInputs.get(id) ?? [];
              queue.push(String(args.message ?? ''));
              this.executorInputs.set(id, queue);
              return { ok: true, content: `已把指令转给执行者 ${id}（不打断它当前这轮）` };
            }
            case 'list_executors': {
              const rows = this.store.listExecutors({ projectId: project.id });
              const statusFilter = Array.isArray(args.status) ? (args.status as string[]) : null;
              const filtered = statusFilter ? rows.filter((r) => statusFilter.includes(r.status)) : rows;
              if (filtered.length === 0) return { ok: true, content: '本项目还没有执行者。' };
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
                source: `项目 ${project.name} · 项目助理会话 ${assistant.sessionId}`,
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
  // D 的派发与结算
  // -------------------------------------------------------------------------

  /**
   * 派一个执行者。**立刻返回**，D 在后台跑。
   *
   * @returns admitted=false 表示在排队（写域相交或达并发上限）。
   */
  async spawn(projectId: string, input: SpawnInput): Promise<SpawnResult> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目 ${projectId} 不存在`);
    if (!input.label.trim() || !input.goal.trim()) {
      throw new Error('派活必须提供 label 与 goal');
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
    const executor: ExecutorRow = {
      id: newId('exe'),
      projectId,
      sessionId: newId('d'),
      label: input.label.trim(),
      goal: input.goal.trim(),
      access: claim.access,
      writeScope: claim.scopes,
      status: 'starting',
      summary: null,
      blockedReason: null,
      metrics: EMPTY_METRICS,
      criteria: input.criteria ?? [],
      policy: input.policy ?? 'unverified_only',
      acceptance: null,
      createdAt: now,
      endedAt: null,
    };
    await this.store.putExecutor(executor);

    // 记一条 turn，留痕"这条需求被判定成什么"，让 C 判错可审计。
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
        await this.finishExecutor(executor.id, 'cancelled', `排队期间中止：${errorText(error)}`);
      }
      return;
    }

    const ready = store.getExecutor(executor.id);
    if (!ready || isExecutorTerminal(ready.status)) {
      this.gate.release(executor.id);
      return;
    }

    // 建 D 的会话行（历史可回看 = "打开原会话"）。
    // systemPrompt 存下来，续聊时才能重建同样的角色设定。
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
      }),
      status: 'running',
      resumable: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.putSession(session);
    // 首轮目标作为 D 会话的第一条用户消息落库（轨迹从这里开始）。
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
        ...(project.tokenGuard ? { tokenGuard: project.tokenGuard } : {}),
        onAbort: () => abort.abort(),
      }),
      project,
      ready,
      abort,
    );

    if (!outcome) {
      await this.finishExecutor(ready.id, 'failed', `执行者异常：${error ?? '未知错误'}`);
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
        // 止损中止：原因要写清楚是"我们主动停的"，不是执行者自己失败。
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
            `执行者「${ready.label}」已被用量上限中止：${reason}。\n` +
            `已消耗：轮次 ${outcome.metrics.turns}、步数 ${outcome.metrics.steps}、` +
            `token ${outcome.metrics.tokensIn + outcome.metrics.tokensOut}。\n` +
            '这是止损线，不是计费。要继续请调高上限。',
          needsUser: true,
        });
      } else {
        const reason = outcome.events.find((e) => e.type === 'error');
        const detail =
          reason && reason.type === 'error' ? reason.message : '执行者没有给出结论';
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

    // 把结论写进 D 的会话轨迹，用户点开这条对话时能看到完整过程。
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
   * 把结算结果交给 C 并让它开口汇报。
   *
   * 这是"谁先完成先报谁"的关键：每个 D 结算时独立触发一次，
   * 互不等待。C 自己去决定措辞（它知道用户刚才说了什么）。
   */
  private async notifyAssistant(project: ProjectRow, executor: ExecutorRow): Promise<void> {
    const ok = executor.status === 'done';
    const body = ok
      ? `执行者「${executor.label}」已完成。\n${executor.summary ?? '（没有留下结论）'}`
      : `执行者「${executor.label}」未完成。\n${executor.blockedReason ?? '（无原因）'}\n${
          executor.summary ?? ''
        }`;

    await this.recordReport({
      projectId: project.id,
      executorId: executor.id,
      kind: ok ? 'done' : 'failed',
      body,
      needsUser: !ok,
    });

    // 投给 C：它会用 followup 语义处理（排到下一轮），然后向用户汇报。
    //
    // **internal=true**：这条是系统给 C 的内部通知，不是用户说的话。
    // 它仍会进入 C 的上下文（否则 C 不知道结算了），但：
    // - 不进入对话流（界面上不显示成用户消息）；
    // - 界面上只显示 C 随后的自然回复。
    // 早期版本把整段结算 + "请立刻向用户汇报这一条结果" 都渲染进了对话，
    // 那是明确的泄漏。
    try {
      await this.userSays(
        project.id,
        `${INTERNAL_NOTICE_PREFIX}\n${body}\n\n请立刻向用户汇报这一条结果。`,
        { source: 'executor', internal: true },
      );
    } catch {
      // C 不在场也不丢事实：report 已落库。
    }
  }

  private async finishExecutor(
    id: string,
    status: 'done' | 'failed' | 'cancelled',
    blockedReason: string | null,
    summary?: string,
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
  }

  /**
   * 用户在界面上点开某条 D 的对话，接着说一句。
   *
   * 这是"用户可直接和 D 对话"（方案 §3.3 / P3）。要点：
   * - D 带着**原有上下文**继续：把它的历史消息作为 priorMessages 传进去；
   * - 只读 D 仍然只读，写域限制也保持不变（不能借续聊越权）；
   * - 续聊产生的结论同样进 D 的会话轨迹，并通知 C（D3：C 要知情）。
   */
  async userSaysToExecutor(
    executorId: string,
    text: string,
  ): Promise<{ ok: boolean; message: string }> {
    const row = this.store.getExecutor(executorId);
    if (!row) return { ok: false, message: `执行者 ${executorId} 不存在` };
    if (row.status === 'starting' || row.status === 'running') {
      return {
        ok: false,
        message: '这个执行者还在跑，请等它结束，或先取消它。',
      };
    }
    if (!text.trim()) return { ok: false, message: '内容不能为空' };

    const project = this.store.getProject(row.projectId);
    if (!project) return { ok: false, message: `项目 ${row.projectId} 不存在` };

    const session = this.store.getSession(row.sessionId);
    if (!session) return { ok: false, message: '找不到这个执行者的会话记录，无法续聊' };

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

    // D3：C 必须知道用户直接跟 D 说的话，否则它的汇总会与事实不符。
    await this.recordReport({
      projectId: project.id,
      executorId: row.id,
      kind: ok ? 'progress' : 'failed',
      body: `用户直接对执行者「${row.label}」追问：「${text}」\n${outcome.finalText}`,
      needsUser: !ok,
    });

    return { ok, message: outcome.finalText || '（没有结论）' };
  }

  /** 读某个执行者的完整轨迹（"打开原会话"）。 */
  executorTranscript(executorId: string): {
    executor: ExecutorRow | undefined;
    messages: ReturnType<Store['messages']>;
  } {
    const row = this.store.getExecutor(executorId);
    if (!row) return { executor: undefined, messages: [] };
    return { executor: row, messages: this.store.messages(row.sessionId) };
  }

  /** 取消一个执行者。 */
  async cancel(executorId: string, projectId?: string): Promise<{ ok: boolean; content: string }> {
    const row = this.store.getExecutor(executorId);
    if (!row) return { ok: false, content: `执行者 ${executorId} 不存在` };
    if (projectId && row.projectId !== projectId) {
      return { ok: false, content: `执行者 ${executorId} 不属于本项目` };
    }
    if (isExecutorTerminal(row.status)) {
      return { ok: false, content: `执行者 ${executorId} 已是终态 ${row.status}，无需取消` };
    }

    this.executorAborts.get(executorId)?.abort();
    await this.finishExecutor(executorId, 'cancelled', null);
    this.gate.release(executorId);
    return { ok: true, content: `执行者 ${executorId} 已取消` };
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
      needsUser: input.needsUser,
      at: Date.now(),
      ackedAt: null,
    };
    await this.store.putReport(report);
    this.emit('runtime', { type: 'report', projectId: input.projectId, report } as RuntimeEvent);
    return report;
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
   * 1. 上次进程被中断时仍在跑的执行者 → 如实标记为失败。
   *    子代理随进程一起死了，`running` 是上一世的记忆，不承认它继续有效。
   *    **不能**悄悄改回队列自动重跑：那会在用户不知情的情况下重复执行副作用。
   * 2. 项目与 C 的会话历史本来就在库里，这里只是把句柄重新挂上，
   *    下一次用户说话时 C 会带着原上下文继续。
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
    // 否则界面会显示一堆"待审批"，但它们对应的执行者早就没了。
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
 * 1. 让 C 在上下文里分辨"这是系统通知"而不是用户说的话；
 * 2. 界面与历史查询据此把它和真实用户消息区分开。
 */
export const INTERNAL_NOTICE_PREFIX = '【执行者结算】';

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
