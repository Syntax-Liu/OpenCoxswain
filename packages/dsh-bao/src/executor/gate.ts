/**
 * 并发闸门 + 写域互斥 + FIFO 队列。
 *
 * 为什么必须自建：dsh 的 `maxActiveSubagents` 超限**直接拒绝**
 * （`ACTIVATION_LIMIT_REACHED`），上游明确"不做排队"。第 6 个 D 在那边会
 * 直接报错，语义上是"工具失败"而不是"排队等待"，用户体验不对。
 *
 * 为什么要带写域互斥：方案 §7.2 / L4。5 个 D 并行时同写一批文件几乎必然发生，
 * 而 C 对"冲突"的判断可能出错。**写域互斥必须与并行上限同时上线**，
 * 否则 C 判错一次就是两个 D 互相覆盖文件。
 *
 * 三条硬约束：
 * 1. 槽位必须跟着**子代理结算**（activation.result）释放，不能跟着
 *    startActivation 返回释放——后者早就返回了，闸门等于没设。
 * 2. 任何异常路径都必须 release，否则队列永久卡死。
 * 3. 声明不了写域的 D 视为与所有写操作冲突 → 串行（保守到最坏情况）。
 */

export interface GateStats {
  readonly running: number;
  readonly queued: number;
  readonly limit: number;
}

export interface Waiter {
  readonly taskId: string;
  /** 该 D 声明的写域集合（已规范化）。空数组代表"声明不了"。 */
  readonly writeScopes: readonly string[];
  readonly resume: () => void;
  readonly reject: (error: Error) => void;
}

/** 写域冲突判定结果。 */
export interface ScopeConflict {
  readonly conflicts: boolean;
  /** 与之冲突的已在跑任务。 */
  readonly withTaskId?: string;
  readonly reason?: string;
}

/**
 * 判断两个写域声明是否相交。
 *
 * 规则（方案 §7.2）：
 * - 任一为空 → 冲突（"声明不了写域的 D 视为与所有写任务冲突，串行"）
 * - 否则按前缀相交：`src/a` 与 `src` 冲突，`src/a` 与 `src/b` 不冲突
 */
export function scopesConflict(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  for (const left of a) {
    for (const right of b) {
      if (overlaps(left, right)) return true;
    }
  }
  return false;
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  // 归一化保证没有尾斜杠；用 "/" 判断路径边界，避免 "src/a" 命中 "src/ab"。
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

export class Gate {
  private readonly running = new Map<string, readonly string[]>();
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

  /** 当前在跑任务的写域，供诊断使用。 */
  snapshot(): ReadonlyMap<string, readonly string[]> {
    return new Map(this.running);
  }

  /**
   * 检查某写域能否立刻准入。纯查询，不改状态。
   * 用于工具层给出"为什么排队"的可读原因。
   */
  check(taskId: string, writeScopes: readonly string[]): ScopeConflict {
    if (this.running.has(taskId)) {
      return { conflicts: true, withTaskId: taskId, reason: '该任务已在闸门中' };
    }
    if (this.running.size >= this.limit) {
      return { conflicts: false, reason: `已达并发上限 ${this.limit}` };
    }
    for (const [otherId, otherScopes] of this.running) {
      if (otherId === taskId) continue;
      if (scopesConflict(writeScopes, otherScopes)) {
        return {
          conflicts: true,
          withTaskId: otherId,
          reason:
            writeScopes.length === 0 || otherScopes.length === 0
              ? '写域未声明，按串行处理'
              : `写域与之相交：${[...otherScopes].join(', ')}`,
        };
      }
    }
    return { conflicts: false };
  }

  /**
   * 申请一个槽位（含写域互斥）。满足两个条件才立刻返回：
   * ① 有空位 ② 与所有在跑任务的写域都不相交。
   * 否则按 FIFO 排队挂起。
   *
   * 被唤醒即视为**已占位**，调用方随后必须用 `release` 归还。
   * `signal` 中止时撤出队列并 reject，避免已取消的任务继续排队占坑。
   */
  async acquire(
    taskId: string,
    writeScopes: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.running.has(taskId)) {
      throw new Error(`任务 ${taskId} 已在闸门中，不能重复申请`);
    }
    if (signal?.aborted) {
      throw abortError();
    }
    if (this.canAdmitNow(taskId, writeScopes)) {
      this.running.set(taskId, writeScopes);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        taskId,
        writeScopes,
        resume: () => {
          signal?.removeEventListener('abort', onAbort);
          this.running.set(taskId, writeScopes);
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

  private canAdmitNow(taskId: string, writeScopes: readonly string[]): boolean {
    if (this.running.size >= this.limit) return false;
    for (const [otherId, otherScopes] of this.running) {
      if (otherId === taskId) continue;
      if (scopesConflict(writeScopes, otherScopes)) return false;
    }
    return true;
  }

  /**
   * 归还槽位并唤醒所有现在可以准入的队首。
   *
   * 注意这里与 M0 不同：因为多了写域约束，一次 release 可能解锁多个
   * **互不冲突**的排队任务。必须逐个检查而不是只唤醒队首，
   * 否则一个写域互斥会让整条队列饿死。
   */
  release(taskId: string): void {
    if (!this.running.delete(taskId)) return;
    let index = 0;
    while (index < this.waiters.length) {
      const waiter = this.waiters[index]!;
      if (!this.canAdmitNow(waiter.taskId, waiter.writeScopes)) {
        index += 1;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.resume();
    }
  }

  /** 进程重启等场景下整体复位。 */
  reset(): void {
    const pending = [...this.waiters];
    this.running.clear();
    this.waiters.length = 0;
    for (const waiter of pending) {
      waiter.reject(new Error('闸门已复位（插件关停），该执行者需要重新派发'));
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
