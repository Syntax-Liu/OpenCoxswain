/**
 * 副作用台账记录器。
 *
 * 记账时机（关键）：
 *
 * ```
 * 工具调用
 *   ├─ 分类（是副作用吗？）
 *   ├─ 去重（幂等键已存在且成功过 → 跳过）
 *   ├─ 落 pending          ← 执行前就落库，崩溃也能看到"它想做这个"
 *   ├─ 危险动作审批 → 拒绝则直接记 rejected，不执行
 *   ├─ 执行
 *   └─ 结算为 succeeded / failed
 * ```
 *
 * 为什么执行前就落库：如果等执行完再记，进程崩在中间就什么都没留下。
 * 用户看到的应该是"它尝试过"，而不是一片空白。
 */
import { newId, type SideEffectRow, type Store } from '../store/store.js';
import {
  KIND_LABEL,
  classifySideEffect,
  sideEffectDeduped,
  sideEffectKey,
  type SideEffectState,
} from './side-effect.js';

export interface LedgerOptions {
  readonly store: Store;
  readonly projectId: string;
  readonly executorId: string;
  /** 参数存多长就够审计。默认 2000 字。 */
  readonly maxArgsChars?: number;
}

export interface PendingEffect {
  /** null 表示这次调用没有副作用（纯读），不需要结算。 */
  readonly row: SideEffectRow | null;
  /** 已经成功过同样的动作 → 调用方可以跳过执行（去重命中）。 */
  readonly skipped: boolean;
}

export class SideEffectLedger {
  constructor(private readonly options: LedgerOptions) {}

  /**
   * 执行前：分类 + 去重 + 落 pending。
   */
  async begin(tool: string, args: Record<string, unknown>): Promise<PendingEffect> {
    const intent = classifySideEffect(tool, args);
    if (!intent) return { row: null, skipped: false };

    const key = sideEffectKey(this.options.executorId, tool, args);

    // 去重：同一次派活里重复写同一个文件，不该记两条。
    // 注意 `proc.exec` 不去重——同一条命令跑两次就是两次副作用。
    if (sideEffectDeduped(intent.kind)) {
      const existing = this.options.store.findSideEffectByKey(this.options.executorId, key);
      if (existing && existing.state === 'succeeded') {
        return { row: existing, skipped: true };
      }
    }

    const row: SideEffectRow = {
      id: newId('eff'),
      projectId: this.options.projectId,
      executorId: this.options.executorId,
      kind: intent.kind,
      target: intent.target,
      state: 'pending',
      reversible: intent.reversible,
      idempotencyKey: key,
      tool,
      args: truncate(safeJson(args), this.options.maxArgsChars ?? 2000),
      note: null,
      createdAt: Date.now(),
      settledAt: null,
    };
    await this.options.store.putSideEffect(row);
    return { row, skipped: false };
  }

  /** 执行后：结算。 */
  async settle(
    row: SideEffectRow | null,
    state: Exclude<SideEffectState, 'pending'>,
    note?: string,
  ): Promise<void> {
    if (!row) return;
    const current = this.options.store.getSideEffect(row.id);
    if (!current) return;
    await this.options.store.putSideEffect({
      ...current,
      state,
      note: note ? truncate(note, 500) : null,
      settledAt: Date.now(),
    });
  }
}

/** 台账的一行可读描述，界面与导出共用。 */
export function describeEffect(row: SideEffectRow): string {
  const state =
    row.state === 'succeeded'
      ? '已执行'
      : row.state === 'failed'
        ? '执行失败'
        : row.state === 'rejected'
          ? '被拒绝（未执行）'
          : '进行中';
  const safe = row.reversible ? '' : '（不可撤销）';
  return `${KIND_LABEL[row.kind]}${safe}：${row.target} — ${state}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（截断）`;
}
