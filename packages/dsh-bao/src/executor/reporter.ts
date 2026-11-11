/**
 * 汇报器：D 结算 → C 向用户汇报。
 *
 * 用户原话（D4，2026-11-11 已定）：
 * > "D 与 D 之间互不影响，谁先完成，C 就先汇报谁的结果"
 *
 * 实现上有两件事必须分开：
 *
 * 1. **先完成先报**：每个 D 结算时独立触发汇报，不等待兄弟。这是天然行为，
 *    因为每个 activation 独立 settle（见 executor/runner.ts）。
 * 2. **去抖合并**：同一批几乎同时完成的多个 D，合并成一条汇报，避免刷屏。
 *    去抖窗口内只暂存，窗口结束一次性交给 C。
 *
 * 注意：结算通知本身由 dsh 投递给 C（P0-T2），因此"C 知道结果"不依赖本模块。
 * 本模块负责的是**把汇报留痕、并按用户要求的节奏让 C 开口**。
 */
import type { ResolvedConfig } from '../config.js';
import type { ExecutorRow, ReportKind } from '../domain.js';
import type { SubagentResultLike } from '../host.js';
import type { Agent } from '../host-types.js';
import { userMessage } from '../host-types.js';
import type { BaoStore } from '../store.js';
import { createReport } from '../store.js';
import { classifyBlock, renderOutput, errorText } from './runner.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** 一条待汇报的结算事实。 */
export interface SettlementItem {
  readonly executor: ExecutorRow;
  readonly ok: boolean;
  readonly body: string;
  readonly blockKind?: 'self-recoverable' | 'needs-user' | 'environment';
}

export interface ReporterDeps {
  readonly store: BaoStore;
  readonly config: ResolvedConfig;
  readonly log: LogFn;
  /** 取某个项目的 C（活 Agent）。取不到返回 undefined。 */
  readonly assistantOf: (projectId: string) => Agent | undefined;
}

export class Reporter {
  /** 按项目聚合待汇报项，key 为 projectId。 */
  private readonly pending = new Map<string, SettlementItem[]>();
  /** 按项目记录去抖定时器。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly deps: ReporterDeps) {}

  /**
   * 收到一次 D 结算。先落库（事实），再进去抖队列。
   *
   * 落库与汇报分开：即使 C 当前不在场（重启后未恢复），事实也要保留，
   * 等 C 回来再补报。
   */
  async onSettled(executor: ExecutorRow, result: SubagentResultLike | Error): Promise<void> {
    const item = toSettlement(executor, result);
    await this.persist(item);
    this.enqueue(executor.projectId, item);
  }

  /** 把一条结算事实写进 report 表（不依赖 C 是否在场）。 */
  private async persist(item: SettlementItem): Promise<void> {
    const kind: ReportKind = item.ok ? 'done' : item.blockKind === 'needs-user' ? 'question' : 'failed';
    try {
      await createReport(
        this.deps.store,
        {
          projectId: item.executor.projectId,
          executorId: item.executor.id,
          kind,
          body: item.body,
          needsUser: !item.ok && item.blockKind !== 'self-recoverable',
        },
        this.deps.config.maxReportChars,
      );
    } catch (error) {
      // 汇报写不进去不能影响执行者状态推进。
      this.deps.log('warn', `汇报落库失败：${errorText(error)}`);
    }
  }

  private enqueue(projectId: string, item: SettlementItem): void {
    if (this.disposed) return;
    const list = this.pending.get(projectId) ?? [];
    list.push(item);
    this.pending.set(projectId, list);

    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);

    const delay = this.deps.config.reportDebounceMs;
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.flush(projectId);
    }, delay);
    // 去抖定时器不应阻止进程退出。
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(projectId, timer);
  }

  /**
   * 把某项目的待汇报项一次性交给 C。
   *
   * 单条时原样汇报；多条时合并成一条（D4 去抖）。
   */
  async flush(projectId: string): Promise<void> {
    const items = this.pending.get(projectId);
    if (!items?.length) return;
    this.pending.delete(projectId);

    const assistant = this.deps.assistantOf(projectId);
    if (!assistant) {
      // C 不在场：事实已落库，等 C 恢复后由 open 流程补报。
      this.deps.log(
        'info',
        `项目 ${projectId} 的项目助理当前未加载，${items.length} 条汇报已落库，待 C 恢复后补报`,
      );
      this.requeueForLater(projectId, items);
      return;
    }

    const text = items.length === 1 ? single(items[0]!) : batch(items);
    try {
      // followup：不打断 C 当前这轮（P0-T4）。
      assistant.followup?.(userMessage(renderInstruction(text), { kind: 'bao-report' }));
    } catch (error) {
      this.deps.log('warn', `向项目助理投递汇报失败：${errorText(error)}`);
      this.requeueForLater(projectId, items);
    }
  }

  /** C 未在场时保留待汇报项，等 C 恢复后补报。 */
  private requeueForLater(projectId: string, items: readonly SettlementItem[]): void {
    const list = this.pending.get(projectId) ?? [];
    this.pending.set(projectId, [...items, ...list]);
  }

  /** 某项目当前积压的待汇报条数（诊断用）。 */
  pendingCount(projectId: string): number {
    return this.pending.get(projectId)?.length ?? 0;
  }

  /** C 恢复后补报积压项。 */
  async replayPending(projectId: string): Promise<void> {
    if (this.pending.size === 0) return;
    await this.flush(projectId);
  }

  /** 立即冲刷所有项目（关停前调用，避免丢掉最后一轮汇报）。 */
  async flushAll(): Promise<void> {
    for (const [projectId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(projectId);
    }
    for (const projectId of [...this.pending.keys()]) {
      await this.flush(projectId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function toSettlement(executor: ExecutorRow, result: SubagentResultLike | Error): SettlementItem {
  if (result instanceof Error) {
    const reason = errorText(result);
    const { kind } = classifyBlock(reason);
    return {
      executor,
      ok: false,
      blockKind: kind,
      body: `执行者「${executor.label}」失败：${reason}`,
    };
  }

  const output = renderOutput(result.output);
  const completed = result.stopReason === 'completed';
  const diagnostic = result.diagnostic ? `\n诊断：${result.diagnostic}` : '';

  if (completed) {
    return {
      executor,
      ok: true,
      body: `执行者「${executor.label}」已完成。\n${output || executor.summary || '（没有留下结论）'}`,
    };
  }

  const reason = `停止原因：${result.stopReason}${diagnostic}`;
  const { kind } = classifyBlock(reason);
  return {
    executor,
    ok: false,
    blockKind: kind,
    body: `执行者「${executor.label}」未完成。${reason}\n${output}`,
  };
}

function single(item: SettlementItem): string {
  const lines = [
    `【执行者结算】「${item.executor.label}」（${item.executor.id}）`,
    item.ok ? '状态：完成' : `状态：未完成（${blockLabel(item.blockKind)}）`,
    '',
    item.body,
  ];
  return lines.join('\n');
}

function batch(items: readonly SettlementItem[]): string {
  const done = items.filter((i) => i.ok);
  const failed = items.filter((i) => !i.ok);
  const lines = [
    `【同一批 ${items.length} 个执行者已结算】`,
    `完成 ${done.length} 个${failed.length ? `，未完成 ${failed.length} 个` : ''}`,
    '',
  ];
  for (const item of items) {
    lines.push(
      `—— 「${item.executor.label}」（${item.executor.id}）${item.ok ? '完成' : `未完成（${blockLabel(item.blockKind)}）`}`,
    );
    lines.push(item.body);
    lines.push('');
  }
  return lines.join('\n');
}

function blockLabel(kind: SettlementItem['blockKind']): string {
  switch (kind) {
    case 'self-recoverable':
      return '可自行重试';
    case 'environment':
      return '环境问题';
    case 'needs-user':
      return '需用户决定';
    default:
      return '未知';
  }
}

/**
 * 给 C 的指令。
 *
 * 这里刻意写成"交给 C 处理"而不是替 C 写好汇报词：
 * 汇报内容与是否打扰用户由 C 判断（方案 §4、P4-T4），插件不越俎代庖。
 */
function renderInstruction(text: string): string {
  return [
    text,
    '',
    '---',
    '以上是执行者结算通知。请按你的职责处理：',
    '1. **立刻向用户汇报这条结果**（谁先完成先报谁，不要等其它执行者）。',
    '2. 若未完成且属于"可自行重试"，先自行换法推进，**不要**打扰用户。',
    '3. 若确实需要用户决定，把问题收敛成**一个**具体问题。',
  ].join('\n');
}
