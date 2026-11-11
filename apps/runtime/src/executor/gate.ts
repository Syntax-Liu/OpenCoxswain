/**
 * 并发闸门 + 写域互斥 + FIFO 队列。
 *
 * 设计前提（方案 §7.2 / L4）：并行上限必须配写域互斥，否则两个 D 同改一批
 * 文件会互相覆盖。
 *
 * 但"保守"不等于"一律串行"。这里区分**三种写域形态**：
 *
 * | 形态 | 含义 | 能否与他人并行 |
 * | --- | --- | --- |
 * | `readonly` | 只读任务，根本不写文件 | ✅ 与任何人并行（包括另一个只读） |
 * | `scopes` 非空 | 声明了要改哪些路径 | 与"路径相交的写任务"串行 |
 * | `scopes` 为空但**不是** readonly | 没说清楚要改哪 | ❌ 与所有写任务串行（最坏假设） |
 *
 * 早期版本只区分"有写域"和"空写域"，把**只读任务也当成"没声明"**，
 * 结果三条互不相干的只读任务被强行排队 —— 这是实打实的并行失效。
 */
import type { ExecutorAccess } from '../store/store.js';

export interface GateStats {
  readonly running: number;
  readonly queued: number;
  readonly limit: number;
}

/** 一个执行者的写域描述。 */
export interface ScopeClaim {
  readonly access: ExecutorAccess;
  readonly scopes: readonly string[];
}

interface Waiter {
  readonly taskId: string;
  readonly claim: ScopeClaim;
  readonly resume: () => void;
  readonly reject: (error: Error) => void;
}

/** 判断两个执行者是否必须串行。 */
export function scopesConflict(a: ScopeClaim | readonly string[], b: ScopeClaim | readonly string[]): boolean {
  const left = toClaim(a);
  const right = toClaim(b);

  // 只读任务不写文件，永远不与任何人冲突。
  if (left.access === 'readonly' || right.access === 'readonly') return false;

  // 任一方"没声明写域"→ 视为与所有写任务冲突（最坏情况假设）。
  if (left.scopes.length === 0 || right.scopes.length === 0) return true;

  for (const x of left.scopes) {
    for (const y of right.scopes) {
      if (overlaps(x, y)) return true;
    }
  }
  return false;
}

/** 兼容旧调用：传字符串数组时视为"读写 + 该写域"。 */
function toClaim(input: ScopeClaim | readonly string[]): ScopeClaim {
  return Array.isArray(input)
    ? { access: 'readwrite', scopes: input as readonly string[] }
    : (input as ScopeClaim);
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  // 按 "/" 判断路径边界，避免 "src/a" 命中 "src/ab"。
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 归一化写域声明：反斜杠转正斜杠、去尾斜杠、去空项、去重。 */
export function normalizeWriteScopes(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const items = typeof raw === 'string' ? raw.split(/[,;\n]/) : raw;
  const out = new Set<string>();
  for (const item of items) {
    const normalized = item.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * 从工具的写域参数里推断访问形态。
 *
 * 约定：`writeScope` 里出现 `readonly` / `只读` 这个特殊值，表示"我只读"。
 * 这样模型不需要学一个新参数，只用约定值即可（提示词里已说明）。
 */
export function parseScopeClaim(
  writeScope: string | readonly string[] | undefined,
): ScopeClaim {
  const raw = normalizeWriteScopes(writeScope);
  const readonly = raw.some((s) => s === 'readonly' || s === '只读' || s === 'ro');
  return {
    access: readonly ? 'readonly' : 'readwrite',
    scopes: readonly ? [] : raw,
  };
}

export class Gate {
  private readonly running = new Map<string, ScopeClaim>();
  private readonly waiters: Waiter[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`并发上限必须是正整数，收到：${String(limit)}`);
    }
    this.limit = limit;
  }

  /** 当前是否有空位（不排队、不占位，仅用于观测）。 */
  get hasFreeSlot(): boolean {
    return this.running.size < this.limit;
  }

  /** 排队中的任务 id，按 FIFO 顺序。 */
  get queuedIds(): readonly string[] {
    return this.waiters.map((w) => w.taskId);
  }

  /**
   * 检查某写域能否立刻准入。纯查询，给了就说清原因。
   */
  check(
    taskId: string,
    claim: ScopeClaim | readonly string[],
  ): { conflicts: boolean; withTaskId?: string; reason?: string } {
    const c = toClaim(claim);
    if (this.running.has(taskId)) {
      return { conflicts: true, withTaskId: taskId, reason: '该任务已在闸门中' };
    }
    if (this.running.size >= this.limit) {
      return { conflicts: false, reason: `已达并发上限 ${this.limit}` };
    }
    if (c.access === 'readonly') return { conflicts: false };

    for (const [otherId, otherClaim] of this.running) {
      if (otherId === taskId) continue;
      if (scopesConflict(c, otherClaim)) {
        return {
          conflicts: true,
          withTaskId: otherId,
          reason:
            c.scopes.length === 0 || otherClaim.scopes.length === 0
              ? '写域未声明，按串行处理'
              : `写域与之相交：${[...otherClaim.scopes].join(', ')}`,
        };
      }
    }
    return { conflicts: false };
  }

  /**
   * 申请槽位（含写域互斥）。有空位且不冲突才立刻返回，否则 FIFO 排队。
   * 被唤醒即视为**已占位**，调用方随后必须 `release`。
   */
  async acquire(
    taskId: string,
    claim: ScopeClaim | readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const c = toClaim(claim);
    if (this.running.has(taskId)) {
      throw new Error(`任务 ${taskId} 已在闸门中，不能重复申请`);
    }
    if (signal?.aborted) throw abortError();
    if (this.canAdmitNow(taskId, c)) {
      this.running.set(taskId, c);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        taskId,
        claim: c,
        resume: () => {
          signal?.removeEventListener('abort', onAbort);
          this.running.set(taskId, c);
          resolve();
        },
        reject,
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private canAdmitNow(taskId: string, claim: ScopeClaim): boolean {
    if (this.running.size >= this.limit) return false;
    if (claim.access === 'readonly') return true;
    for (const [otherId, otherClaim] of this.running) {
      if (otherId === taskId) continue;
      if (scopesConflict(claim, otherClaim)) return false;
    }
    return true;
  }

  /**
   * 归还槽位并唤醒**所有现在可准入**的排队项。
   *
   * 只唤醒队首会让整条队列被一个写域互斥饿死。
   */
  release(taskId: string): void {
    if (!this.running.delete(taskId)) return;
    let index = 0;
    while (index < this.waiters.length) {
      const waiter = this.waiters[index]!;
      if (!this.canAdmitNow(waiter.taskId, waiter.claim)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.resume();
    }
  }

  reset(): void {
    const pending = [...this.waiters];
    this.running.clear();
    this.waiters.length = 0;
    for (const waiter of pending) {
      waiter.reject(new Error('闸门已复位（运行时关停），该执行者需要重新派发'));
    }
  }

  stats(): GateStats {
    return { running: this.running.size, queued: this.waiters.length, limit: this.limit };
  }
}

function abortError(): Error {
  const err = new Error('排队期间被取消');
  err.name = 'AbortError';
  return err;
}
