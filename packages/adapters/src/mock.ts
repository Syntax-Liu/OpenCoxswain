import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  newId,
  now,
  type AcceptanceResult,
  type CostLedger,
  type TaskContract,
  type WorkerResult,
} from '@opencoxswain/shared';
import type {
  HealthStatus,
  InputDelivery,
  InputReceipt,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  SessionOptions,
} from './adapter.js';
import { classifyAction } from './guard.js';
import {
  collectArtifacts,
  commitChanges,
  headOf,
  isWithin,
  judgeCriterion,
} from './tooling.js';

interface MockAction {
  tool: string;
  input?: unknown;
}

interface MockInput {
  files?: Array<{ path: string; content: string }>;
  actions?: MockAction[];
  command?: string;
  fail?: boolean;
  cost?: Partial<CostLedger>;
  sleepMs?: number;
  /** 每个动作之间的等待，便于观察运行中投递。 */
  actionDelayMs?: number;
}

class MockSession implements RuntimeSession {
  readonly id = newId('ses');
  cancelled = false;
  paused = false;
  result: WorkerResult | null = null;
  baseHead: string | null = null;
  readonly inbox: InputDelivery[] = [];

  constructor(
    readonly taskId: string,
    readonly worktree: string,
    readonly options: SessionOptions,
  ) {}
}

const DEFAULT_COST: CostLedger = { tokensIn: 6000, tokensOut: 1200, usd: 0.02, minutes: 0.05 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 离线可跑的运行时替身：真实 worktree 写文件、跑命令、产出 diff。 */
export class MockRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'mock';
  readonly version = '0.7.0';
  readonly supportsApprovalGate = true;
  readonly capabilities = { input: true, approvalGate: true, resume: false };

  private readonly sessions = new Map<string, MockSession>();
  private readonly commandTimeoutMs: number;

  constructor(options: { commandTimeoutMs?: number } = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: 'mock adapter ready' };
  }

  async createSession(options: SessionOptions): Promise<RuntimeSession> {
    const info = await stat(options.worktree);
    if (!info.isDirectory()) {
      throw new Error(`worktree 不是目录：${options.worktree}`);
    }
    const session = new MockSession(options.taskId, options.worktree, options);
    session.baseHead = await headOf(options.worktree);
    this.sessions.set(session.id, session);
    return session;
  }

  async cancel(session: RuntimeSession): Promise<void> {
    session.cancelled = true;
  }

  async sendInput(session: RuntimeSession, input: InputDelivery): Promise<InputReceipt> {
    const target = this.requireSession(session);
    target.inbox.push(input);
    return 'delivered';
  }

  async pause(session: RuntimeSession): Promise<void> {
    session.paused = true;
  }

  async resume(session: RuntimeSession): Promise<void> {
    session.paused = false;
  }

  async collect(session: RuntimeSession): Promise<WorkerResult> {
    const target = this.requireSession(session);
    if (!target.result) {
      throw new Error(`会话 ${session.id} 还没有结果`);
    }
    return target.result;
  }

  async dispose(session: RuntimeSession): Promise<void> {
    this.sessions.delete(session.id);
  }

  async *send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const artifactsDir = this.artifactsDir(session, task);
    await mkdir(artifactsDir, { recursive: true });
    const logsRef = path.join(artifactsDir, 'worker.log');
    await writeFile(logsRef, '');

    const log = async (event: RuntimeEvent): Promise<void> => {
      await appendFile(logsRef, `${JSON.stringify(event)}\n`);
    };
    const emit = async (event: RuntimeEvent): Promise<RuntimeEvent> => {
      await log(event);
      return event;
    };
    const drain = async (): Promise<RuntimeEvent[]> => {
      const events: RuntimeEvent[] = [];
      while (target.inbox.length > 0) {
        const item = target.inbox.shift()!;
        events.push(await emit({ type: 'input_received', at: now(), inputId: item.id }));
        events.push(
          await emit({
            type: 'message',
            at: now(),
            text: `已收到中途消息（${item.source}）：${item.text}`,
          }),
        );
      }
      return events;
    };

    yield await emit({ type: 'started', at: now() });
    const input = this.mockInput(task);

    if (input?.sleepMs) {
      const until = Date.now() + input.sleepMs;
      while (Date.now() < until) {
        await delay(50);
        for (const event of await drain()) yield event;
      }
    }

    await this.waitWhilePaused(session);
    if (session.cancelled) return;
    for (const event of await drain()) yield event;

    if (input?.fail) {
      yield await emit({
        type: 'error',
        at: now(),
        message: 'mock 指定失败',
        retryable: true,
      });
      return;
    }

    const totalCost = this.costFor(input);
    const files = input?.files ?? [];
    const parts = files.length + 1;
    let costIndex = 0;
    let emittedCost: CostLedger = { tokensIn: 0, tokensOut: 0, usd: 0, minutes: 0 };
    const nextCost = (): CostLedger => {
      costIndex += 1;
      const last = costIndex >= parts;
      const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
      const round2 = (value: number): number => Math.round(value * 100) / 100;
      const slice: CostLedger = last
        ? {
            tokensIn: totalCost.tokensIn - emittedCost.tokensIn,
            tokensOut: totalCost.tokensOut - emittedCost.tokensOut,
            usd: round4(totalCost.usd - emittedCost.usd),
            minutes: round2(totalCost.minutes - emittedCost.minutes),
          }
        : {
            tokensIn: Math.round(totalCost.tokensIn / parts),
            tokensOut: Math.round(totalCost.tokensOut / parts),
            usd: round4(totalCost.usd / parts),
            minutes: round2(totalCost.minutes / parts),
          };
      emittedCost = {
        tokensIn: emittedCost.tokensIn + slice.tokensIn,
        tokensOut: emittedCost.tokensOut + slice.tokensOut,
        usd: round4(emittedCost.usd + slice.usd),
        minutes: round2(emittedCost.minutes + slice.minutes),
      };
      return slice;
    };

    yield await emit({ type: 'cost', at: now(), cost: nextCost() });

    for (const action of input?.actions ?? []) {
      await this.waitWhilePaused(session);
      if (session.cancelled) return;
      for (const event of await drain()) yield event;
      if (input?.actionDelayMs) {
        const until = Date.now() + input.actionDelayMs;
        while (Date.now() < until) {
          await delay(50);
          for (const event of await drain()) yield event;
        }
      }
      yield await emit({ type: 'tool_call', at: now(), tool: action.tool, input: action.input ?? null });
      const category = classifyAction(action.tool, action.input);
      if (category && session.options.gate) {
        const decision = await session.options.gate.request({
          tool: action.tool,
          input: action.input ?? null,
          category,
        });
        if (decision === 'rejected') {
          yield await emit({
            type: 'tool_result',
            at: now(),
            tool: action.tool,
            output: { ok: false, rejected: true },
          });
          yield await emit({
            type: 'error',
            at: now(),
            message: `危险动作被拒绝：${action.tool}（${category}）`,
            retryable: false,
          });
          return;
        }
      }
      yield await emit({
        type: 'tool_result',
        at: now(),
        tool: action.tool,
        output: { ok: true, simulated: true },
      });
    }

    if (session.options.role.readOnly) {
      yield await emit({
        type: 'message',
        at: now(),
        text: `${session.options.role.name} 以只读方式运行，不修改 worktree。`,
      });
    } else {
      for (const file of files) {
        await this.waitWhilePaused(session);
        if (session.cancelled) return;
        for (const event of await drain()) yield event;
        const targetPath = path.resolve(session.worktree, file.path);
        if (!isWithin(session.worktree, targetPath)) {
          yield await emit({
            type: 'error',
            at: now(),
            message: `拒绝写入 worktree 之外的路径：${file.path}`,
            retryable: false,
          });
          return;
        }
        yield await emit({ type: 'tool_call', at: now(), tool: 'file_write', input: { path: file.path } });
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.content, 'utf8');
        yield await emit({ type: 'tool_result', at: now(), tool: 'file_write', output: { ok: true } });
        yield await emit({ type: 'cost', at: now(), cost: nextCost() });
      }
      const committed = await commitChanges(session.worktree, `opencoxswain: ${task.title}`);
      if (committed) {
        yield await emit({ type: 'message', at: now(), text: '变更已提交到任务分支。' });
      }
    }

    const acceptance: AcceptanceResult[] = [];
    for (const [index, criterion] of task.acceptance_criteria.entries()) {
      await this.waitWhilePaused(session);
      if (session.cancelled) return;
      const result = await judgeCriterion(criterion, {
        worktree: session.worktree,
        baseHead: target.baseHead,
        roleName: session.options.role.name,
        writeScope: task.write_scope ?? [],
        env: { ...process.env, ...session.options.env },
        timeoutMs: this.commandTimeoutMs,
      });
      acceptance.push(result);
      yield await emit({
        type: 'progress',
        at: now(),
        percent: Math.round(((index + 1) / task.acceptance_criteria.length) * 70) + 20,
        note: `${criterion.id} ${result.status}`,
      });
    }

    const artifacts = await collectArtifacts({
      worktree: session.worktree,
      baseHead: target.baseHead,
      task,
      roleName: session.options.role.name,
      acceptance,
      artifactsDir,
    });
    for (const artifact of artifacts) {
      yield await emit({ type: 'artifact', at: now(), artifact });
    }
    for (const event of await drain()) yield event;

    const cost = this.costFor(input);
    const passed = acceptance.filter((item) => item.status === 'passed').length;
    const failed = acceptance.filter((item) => item.status === 'failed').length;
    const unverified = acceptance.filter((item) => item.status === 'unverified').length;
    const result: WorkerResult = {
      summary: `${session.options.role.name} 完成：${artifacts.length} 个产物，验收 ${passed} 通过 / ${failed} 失败 / ${unverified} 待确认。`,
      artifacts,
      acceptance,
      cost,
      logsRef,
    };
    target.result = result;
    yield await emit({ type: 'progress', at: now(), percent: 100, note: '完成' });
    yield await emit({ type: 'finished', at: now(), result });
  }

  private requireSession(session: RuntimeSession): MockSession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`未知会话：${session.id}`);
    return target;
  }

  private artifactsDir(session: RuntimeSession, task: TaskContract): string {
    const root =
      session.options.env.OPENCOXSWAIN_ARTIFACTS_DIR ??
      path.join(os.tmpdir(), 'opencoxswain-artifacts');
    return path.join(root, task.task_id);
  }

  private mockInput(task: TaskContract): MockInput | null {
    const value = task.inputs?.mock;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as MockInput;
  }

  private costFor(input: MockInput | null): CostLedger {
    return { ...DEFAULT_COST, ...input?.cost };
  }

  private async waitWhilePaused(session: RuntimeSession): Promise<void> {
    while (session.paused && !session.cancelled) {
      await delay(100);
    }
  }
}
