/**
 * 冲突判定：用户连发的新需求，与正在跑的执行者是什么关系。
 *
 * 方案 §4 的产品口径：
 * 1. 用户新消息**默认走 `followup`，永远不打断**（P0-T4 已证实）。
 * 2. 判定由 **C 自己做**，因为只有 C 有项目上下文。
 * 3. 判定结果落 `TurnRow.judged`，让"C 判错了"可审计。
 *
 * 本模块提供的是**工程侧的兜底判定**，不是替代 C 的语义判断：
 *
 * - C 在派活时显式声明判定（`spawn_executor` 的 `judged` 参数）；
 * - C 没声明时，用这里基于**写域相交**的保守规则先判一次，
 *   并把结论如实标成"系统推断"。
 *
 * 为什么以写域为主：方案 L4 —— C 把"冲突"误判成"并列"，后果就是两个 D
 * 同改一批文件。写域相交是这件事唯一可机械验证的信号。
 */
import type { ExecutorRow, TurnJudgment } from '../domain.js';
import { isExecutorTerminal } from '../domain.js';
import { normalizeWriteScopes, scopesConflict } from '../executor/gate.js';

export interface JudgeInput {
  /** 新需求声明的写域（可空）。 */
  readonly writeScopes: readonly string[];
  /** 该项目当前在跑的执行者。 */
  readonly active: readonly ExecutorRow[];
}

export interface JudgeResult {
  readonly judged: TurnJudgment;
  /** 是否由本模块推断（C 未显式声明）。 */
  readonly inferred: boolean;
  /** 可读依据，直接给 C 与用户看。 */
  readonly reason: string;
  /** 判定为冲突时，建议对哪个执行者下手。 */
  readonly conflictWith?: string;
}

/**
 * 推断判定。
 *
 * - 没有在跑的执行者 → `new`
 * - 有在跑，但写域全部不相交 → `parallel`
 * - 任一写域相交 → `conflict`
 */
export function judge(input: JudgeInput): JudgeResult {
  const active = input.active.filter((e) => !isExecutorTerminal(e.status));
  if (active.length === 0) {
    return { judged: 'new', inferred: true, reason: '当前没有在跑的执行者' };
  }

  const scopes = normalizeWriteScopes(input.writeScopes);
  for (const executor of active) {
    const otherScopes = normalizeWriteScopes(executor.writeScope);
    if (scopesConflict(scopes, otherScopes)) {
      const why =
        scopes.length === 0 || otherScopes.length === 0
          ? '任一方未声明写域，按冲突处理（方案 §7.2）'
          : `写域相交：${[...otherScopes].join(', ')}`;
      return {
        judged: 'conflict',
        inferred: true,
        reason: `与执行者「${executor.label}」（${executor.id}）${why}`,
        conflictWith: executor.id,
      };
    }
  }

  return {
    judged: 'parallel',
    inferred: true,
    reason: `与在跑的 ${active.length} 个执行者写域均不相交，可并行`,
  };
}

/**
 * 校验 C 显式声明的判定是否被工程事实否定。
 *
 * 如果 C 说"并列"但写域其实相交，这里**不改变 C 的判定**（C 有上下文），
 * 但要把矛盾如实返回：「C 说并行，但两个 D 写域相交，已由闸门串行」。
 * 宁可让 C 知道自己的判断与事实不符，也不要悄悄改写它的结论。
 */
export function crossCheck(
  declared: TurnJudgment,
  input: JudgeInput,
): { readonly consistent: boolean; readonly note?: string } {
  const inferred = judge(input);
  if (declared === 'conflict' && inferred.judged === 'conflict') {
    return { consistent: true };
  }
  if (declared === 'conflict') {
    return { consistent: true };
  }
  if (inferred.judged === 'conflict') {
    return {
      consistent: false,
      note:
        `你判定为「${judgedLabel(declared)}」，但${inferred.reason}。` +
        '这些执行者会被写域闸门串行执行（不会同时改同一批文件），' +
        '但你的判断与事实不符，请确认是否要调整或取消其中一个。',
    };
  }
  return { consistent: true };
}

export function judgedLabel(judged: TurnJudgment): string {
  switch (judged) {
    case 'new':
      return '新增';
    case 'parallel':
      return '并列';
    case 'conflict':
      return '冲突';
  }
}
