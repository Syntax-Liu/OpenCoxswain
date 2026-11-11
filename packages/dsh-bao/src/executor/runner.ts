/**
 * D 执行者：派发、结算、归类卡点、可续追问。
 *
 * 关键设计（docs/self-developed-plan.md §2、§6 P1、P4）：
 *
 * 1. **派活立即返回**：`start` 不等待 activation 结算，否则并行就不成立了。
 * 2. **槽位跟着 `activation.result` 释放**，不跟着 `startActivation` 返回释放。
 * 3. **谁先完成先报谁**：每个 activation 独立结算、独立回调，
 *    D 与 D 之间互不影响（用户原话，D4 已定）。
 * 4. **结算通知由 dsh 投递给 C**（P0-T2 已证实），插件不重复注入，
 *    只把结论落库并把"该汇报了"这个事实交给 Reporter。
 * 5. **卡点三分类**（P4-T1）：自己能解决的 / 必须问用户的 / 环境问题。
 *    插件给出分类建议，由 C 决定怎么推进。
 */
import type { ResolvedConfig } from '../config.js';
import type { ExecutorRow } from '../domain.js';
import { isExecutorTerminal } from '../domain.js';
import type { Gate } from './gate.js';
import { normalizeWriteScopes } from './gate.js';
import type {
  HostApi,
  SubagentActivationLike,
  SubagentResultLike,
  SubagentRuntimeLike,
} from '../host.js';
import type { Agent } from '../host-types.js';
import type { BaoStore } from '../store.js';
import {
  createExecutor,
  finishExecutor,
  getProject,
  listActiveExecutors,
  listExecutors,
  patchExecutor,
} from '../store.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** 卡点三分类。方案 §6 P4-T1。 */
export type BlockKind = 'self-recoverable' | 'needs-user' | 'environment';

export interface BlockClassification {
  readonly kind: BlockKind;
  /** 给 C 的可读建议。 */
  readonly hint: string;
}

/**
 * 把 D 的失败原因归类。
 *
 * 这是**规则判断**，不调用 LLM：宁可保守地归类成"必须问用户"，
 * 也不要让 C 在没有依据的情况下自行重试用尽预算。
 */
export function classifyBlock(reason: string): BlockClassification {
  const text = reason.toLowerCase();

  // 环境问题：缺依赖、权限、磁盘、端口、网络不可达。
  if (
    /enoent|command not found|不是内部或外部命令|permission denied|eacces|eperm|no such file or directory|enospc|disk full|eaddrinuse|port .* in use|network|econnrefused|etimedout|连不上|没有权限/.test(
      text,
    )
  ) {
    return {
      kind: 'environment',
      hint: '环境问题：如实报告并给出修复建议，不要反复重试同一环境错误。',
    };
  }

  // 自己能解决：模型可自行换法的错误（改错路径、类型错误、测试失败）。
  if (
    /typeerror|referenceerror|syntaxerror|assertion|expected .* received|test failed|测试失败|修改不存在的|does not exist/.test(
      text,
    )
  ) {
    return {
      kind: 'self-recoverable',
      hint: '可由 D 自己换法重试（例如换文件、先读再改），不要打扰用户。',
    };
  }

  return {
    kind: 'needs-user',
    hint: '无法判断成因，攒成一个具体问题问用户，一次只问一件。',
  };
}

export interface StartExecutorInput {
  readonly projectId: string;
  readonly label: string;
  readonly goal: string;
  readonly writeScope?: string | readonly string[];
}

export interface StartOutcome {
  readonly executor: ExecutorRow;
  /** 是否立刻拿到了槽位。false 表示在排队，原因为写域或并发上限。 */
  readonly admitted: boolean;
  readonly queueReason: string;
  readonly position: number;
}

export interface ExecutorDeps {
  readonly store: BaoStore;
  readonly gate: Gate;
  readonly config: ResolvedConfig;
  readonly host: HostApi;
  readonly log: LogFn;
  /** D 结算回调：由 Reporter 实现"先完成先报"。 */
  readonly onSettled: (executor: ExecutorRow, result: SubagentResultLike | Error) => void | Promise<void>;
}

/**
 * 在途 activation 的内存索引，供取消与进程退出时收敛。
 *
 * 与闸门分开记录：闸门管"准入名额"，这里管"我手上还有哪几个孩子在跑，
 * 关停时要负责把它们收回来"。
 */
export class ActivationRegistry {
  private readonly live = new Map<string, SubagentActivationLike>();

  set(executorId: string, activation: SubagentActivationLike): void {
    this.live.set(executorId, activation);
  }

  get(executorId: string): SubagentActivationLike | undefined {
    return this.live.get(executorId);
  }

  delete(executorId: string): void {
    this.live.delete(executorId);
  }

  entries(): IterableIterator<[string, SubagentActivationLike]> {
    return this.live.entries();
  }

  get size(): number {
    return this.live.size;
  }
}

export class ExecutorRunner {
  readonly activations = new ActivationRegistry();

  constructor(private readonly deps: ExecutorDeps) {}

  get store(): BaoStore {
    return this.deps.store;
  }

  /**
   * 由 C 派活。`parent` 必须是 C 的活 Agent。
   *
   * 立即返回：登记执行者行 + 在后台等槽位。真正等到的结果通过
   * `onSettled` 回调给 Reporter，Reporter 再交给 C。
   */
  async start(input: StartExecutorInput, parent: Agent): Promise<StartOutcome> {
    const { store, gate, log } = this.deps;
    const scopes = normalizeWriteScopes(input.writeScope);

    const row = await createExecutor(store, {
      projectId: input.projectId,
      label: input.label,
      goal: input.goal,
      writeScope: scopes.join(','),
    });

    const conflict = gate.check(row.id, scopes);
    const willAdmit = !conflict.conflicts && gate.hasFreeSlot;
    const queueReason = conflict.conflicts
      ? (conflict.reason ?? '写域冲突')
      : willAdmit
        ? ''
        : `已达并发上限 ${this.deps.config.maxConcurrentExecutors}`;

    log(
      'info',
      `派活 ${row.id} → ${input.projectId}：${row.label}` +
        (queueReason ? `（排队：${queueReason}）` : ''),
    );

    void this.run(row.id, parent, scopes).catch((error: unknown) => {
      log('error', `执行者 ${row.id} 派活链路异常：${errorText(error)}`);
    });

    return {
      executor: row,
      admitted: willAdmit,
      queueReason,
      position: queueReason ? gate.stats().queued : 0,
    };
  }

  private async run(
    executorId: string,
    parent: Agent,
    scopes: readonly string[],
  ): Promise<void> {
    const { store, gate, config, log } = this.deps;

    const initial = await store.executors.get(executorId);
    if (!initial) {
      log('warn', `执行者 ${executorId} 不存在，跳过派活`);
      return;
    }
    if (isExecutorTerminal(initial.status)) {
      log('info', `执行者 ${executorId} 当前状态 ${initial.status}，不再派活`);
      return;
    }

    try {
      await gate.acquire(executorId, scopes);
    } catch (error) {
      // 排队期间被取消：不要把终态覆盖掉。
      const current = await store.executors.get(executorId);
      if (current && !isExecutorTerminal(current.status)) {
        await finishExecutor(store, executorId, 'cancelled', {
          blockedReason: `排队期间中止：${errorText(error)}`,
        });
      }
      return;
    }

    // 拿到槽位后再确认一次：排队期间可能已被取消。
    const ready = await store.executors.get(executorId);
    if (!ready || isExecutorTerminal(ready.status)) {
      gate.release(executorId);
      return;
    }

    const project = getProject(store, ready.projectId);
    if (!project) {
      await this.failExecutor(executorId, `执行者引用的项目 ${ready.projectId} 不存在`);
      gate.release(executorId);
      return;
    }

    if (!parent.followup && !parent.id) {
      // 结构性校验：拿不到父 Agent 就说明派活来源不对。
      await this.failExecutor(
        executorId,
        '派活失败：父 Agent（项目助理 C）无效，请从 C 的会话内调用 spawn_executor',
      );
      gate.release(executorId);
      return;
    }

    let activation: SubagentActivationLike;
    try {
      const subagents = requireSubagents(this.deps.host);
      const controller = new AbortController();
      activation = await subagents.startActivation({
        provider: config.provider,
        label: ready.label,
        request: {
          cwd: project.rootPath,
          agentPreset: config.executorPreset,
          // 子代理入参是 ContentBlock[]，这里给一个文本块即可。
          prompt: [{ type: 'text', text: buildPrompt(ready, project.name) }],
          parent,
          signal: controller.signal,
        },
        signal: controller.signal,
        // delivery:'parent' → dsh 自己把结算通知投递给 C（P0-T2）。
        delivery: 'parent',
      });
      await patchExecutor(store, executorId, {
        status: 'running',
        sessionId: activation.childId,
      });
      this.activations.set(executorId, activation);
    } catch (error) {
      const reason = errorText(error);
      await this.failExecutor(executorId, `派活失败：${reason}`);
      gate.release(executorId);
      log('error', `执行者 ${executorId} 派活失败：${reason}`);
      return;
    }

    // 结算后才释放槽位。result 在子代理（含后代）收敛后才 settle。
    // 每个 D 独立结算 —— 这就是"谁先完成先汇报谁"的物理基础（D4）。
    void activation.result.then(
      async (result) => {
        try {
          await this.onSettled(executorId, result);
        } finally {
          this.activations.delete(executorId);
          gate.release(executorId);
        }
      },
      async (error: unknown) => {
        try {
          await this.onFailed(executorId, errorText(error));
        } finally {
          this.activations.delete(executorId);
          gate.release(executorId);
        }
      },
    );
  }

  /** 子代理正常结算：落终态 + 交给 Reporter。 */
  private async onSettled(executorId: string, result: SubagentResultLike): Promise<void> {
    const { store, log } = this.deps;
    const current = await store.executors.get(executorId);
    if (!current) return;

    // 已被取消的不要再改回来。
    if (isExecutorTerminal(current.status)) {
      log('info', `执行者 ${executorId} 已是终态 ${current.status}，忽略结算`);
      return;
    }

    const output = renderOutput(result.output);
    const summary = summaryOf(result.structured, output) ?? output.slice(0, 500);
    const completed = result.stopReason === 'completed';

    // P0-T3：有持久化就能续聊，resumable 置 1，让 UI 敢于开放追问入口。
    const resumable: 0 | 1 = current.sessionId ? 1 : 0;

    const updated = completed
      ? await finishExecutor(store, executorId, 'done', { summary: summary || null })
      : await finishExecutor(store, executorId, 'failed', {
          summary: summary || null,
          blockedReason: formatBlockReason(`执行者停止原因：${result.stopReason}`, result.diagnostic),
        });

    log('info', `执行者 ${executorId} 结算：${result.stopReason}`);

    const final = await patchExecutor(store, executorId, { resumable });
    await this.deps.onSettled(final, result);
    void updated;
  }

  private async onFailed(executorId: string, reason: string): Promise<void> {
    const failed = await this.failIfLive(executorId, reason);
    if (failed) {
      await this.deps.onSettled(failed, new Error(reason));
    }
  }

  private async failExecutor(executorId: string, reason: string): Promise<void> {
    await this.failIfLive(executorId, reason);
  }

  private async failIfLive(executorId: string, reason: string): Promise<ExecutorRow | undefined> {
    const { store, log } = this.deps;
    const current = await store.executors.get(executorId);
    if (!current) return undefined;
    if (isExecutorTerminal(current.status)) return undefined;
    log('error', `执行者 ${executorId} 失败：${reason}`);
    return finishExecutor(store, executorId, 'failed', {
      blockedReason: formatBlockReason(reason),
    });
  }

  /** 取消一个执行者。排队中直接改状态；运行中先 dispose 再落终态。 */
  async cancel(executorId: string): Promise<{ ok: boolean; message: string }> {
    const { store, gate } = this.deps;
    const row = await store.executors.get(executorId);
    if (!row) return { ok: false, message: `执行者 ${executorId} 不存在` };
    if (isExecutorTerminal(row.status)) {
      return { ok: false, message: `执行者 ${executorId} 已是终态 ${row.status}，无需取消` };
    }

    const activation = this.activations.get(executorId);
    if (activation) {
      try {
        await activation.dispose();
      } catch (error) {
        this.deps.log('warn', `取消执行者 ${executorId} 时 dispose 失败：${errorText(error)}`);
      }
      this.activations.delete(executorId);
    }

    await finishExecutor(store, executorId, 'cancelled', { blockedReason: null });
    gate.release(executorId);
    return { ok: true, message: `执行者 ${executorId} 已取消` };
  }

  /**
   * C 给运行中的 D 追加指令（P4-T2：① 类卡点自己处理）。
   *
   * 走 `sendMessage`：`followup` 语义，不打断 D 当前轮（与用户连发同理）。
   */
  async message(
    executorId: string,
    sender: Agent,
    text: string,
  ): Promise<{ ok: boolean; message: string }> {
    const { store, host, log } = this.deps;
    const row = await store.executors.get(executorId);
    if (!row) return { ok: false, message: `执行者 ${executorId} 不存在` };
    if (isExecutorTerminal(row.status)) {
      if (row.resumable === 1) {
        return {
          ok: false,
          message:
            `执行者 ${executorId} 已结束（${row.status}），但它的会话可续。` +
            '请让用户走"继续追问"入口，或派一个新的执行者。',
        };
      }
      return { ok: false, message: `执行者 ${executorId} 已结束（${row.status}），无法接收指令` };
    }
    if (!row.sessionId) {
      return { ok: false, message: `执行者 ${executorId} 还在排队，尚未建立会话` };
    }
    const subagents = host.subagents;
    if (!subagents?.sendMessage) {
      return {
        ok: false,
        message: '宿主未提供 ctx.subagents.sendMessage，无法向运行中的执行者追加指令',
      };
    }
    try {
      await subagents.sendMessage(sender, row.sessionId, [{ type: 'text', text }]);
      return { ok: true, message: `已把指令转给执行者 ${executorId}（不打断它当前这轮）` };
    } catch (error) {
      const reason = errorText(error);
      log('warn', `向执行者 ${executorId} 发消息失败：${reason}`);
      return { ok: false, message: `追加指令失败：${reason}` };
    }
  }

  /** 插件卸载：取消所有在途 activation，避免留下孤儿子代理。 */
  async disposeAll(): Promise<void> {
    const live = [...this.activations.entries()];
    for (const [executorId, activation] of live) {
      try {
        await activation.dispose();
      } catch (error) {
        this.deps.log('warn', `关停时 dispose 执行者 ${executorId} 失败：${errorText(error)}`);
      }
      this.activations.delete(executorId);
    }
    this.deps.gate.reset();
  }

  /** 某项目当前在跑的 D 数量（用于 C 的并行度判断）。 */
  activeCount(projectId: string): number {
    return listActiveExecutors(this.deps.store, projectId).length;
  }

  /** 某项目的全部执行者，按创建时间。 */
  list(projectId: string, limit?: number): ExecutorRow[] {
    return listExecutors(this.deps.store, { projectId, ...(limit ? { limit } : {}) });
  }
}

function requireSubagents(host: HostApi): SubagentRuntimeLike {
  if (!host.subagents) {
    throw new Error(
      '宿主未提供 ctx.subagents，无法派活。请确认 dsh 装载了 @deepseek-ai/dsh-subagent 与一个后端插件。',
    );
  }
  return host.subagents;
}

/** 任务简报：自足、可独立理解（spawn 子代理不带父会话历史）。 */
export function buildPrompt(executor: ExecutorRow, projectName: string): string {
  const scope = executor.writeScope
    ? executor.writeScope
    : '（未声明 —— 本次按串行执行，仍只允许改本项目）';
  return [
    `# 执行者任务简报`,
    '',
    `项目：${projectName}`,
    `执行者：${executor.label}`,
    '',
    '## 目标',
    executor.goal,
    '',
    '## 写域',
    scope,
    '',
    '## 协作约束',
    '1. 你在本项目自己的工作目录内工作，只改本项目的文件。',
    '2. 你不能再次派生子代理（深度上限为 1）；需要并行时用普通并行工具。',
    '3. **先用一句话写结论，再补充细节。**',
    '   **不要**用"给父会话发消息"的方式结尾 —— 那样你的收尾结论会被省略，',
    '   项目助理将看不到你做了什么。',
    '4. 结论按三段写：做了什么 / 验证了什么 / 还需要用户决定什么。',
    '5. 如果被卡住，明确写出卡点与建议的下一步，不要假装完成。',
    '',
    '## 卡住时的处理',
    '- 自己能修好的（路径写错、类型错误、测试失败）：换法重试一次，不要停下来问。',
    '- 环境问题（缺依赖、没权限）：停止并如实报告，附修复建议。',
    '- 必须人决定的：把问题写成一句话，明确你要哪个答案。',
  ].join('\n');
}

/** 把卡点分类写进 blockedReason，让 C 与看板都能直接读到判断依据。 */
function formatBlockReason(reason: string, diagnostic?: string): string {
  const { kind, hint } = classifyBlock(`${reason} ${diagnostic ?? ''}`);
  const label =
    kind === 'self-recoverable' ? '可自行重试' : kind === 'environment' ? '环境问题' : '需用户决定';
  return `${reason}\n\n[卡点分类：${label}] ${hint}`;
}

/** 把模型输出的 content blocks 拍平成文本。 */
export function renderOutput(blocks: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block && typeof block === 'object') {
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        parts.push(record.text);
      }
    }
  }
  return parts.join('').trim();
}

function summaryOf(structured: unknown, output: string): string | null {
  if (structured && typeof structured === 'object') {
    const record = structured as Record<string, unknown>;
    for (const key of ['summary', 'result', 'conclusion', 'message']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  if (output) {
    const firstLine = output.split('\n').find((line) => line.trim());
    return firstLine ? firstLine.trim().slice(0, 500) : null;
  }
  return null;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `[${code}] ${error.message}` : error.message;
  }
  return String(error);
}
