/**
 * 验收：**D 说完成不等于完成**。
 *
 * 这是产品最容易被骗的地方。一个 Agent可以：
 * - 什么都没改，却汇报"已完成"；
 * - 改了，但改错了文件；
 * - 写了跑不通的代码。
 *
 * 所以验收的核心原则是：**只采信系统自己复核出来的证据，不采信 Agent 的自述**。
 *
 * 三类验收标准：
 *
 * | 类型 | 怎么验 | 谁说了算 |
 * | --- | --- | --- |
 * | `command` | 系统在项目目录里**独立重跑**这条命令 | 退出码 |
 * | `diff` | 系统统计工作区相对基线的改动 | 增删行数 |
 * | `human` | 需要人看一眼 | 人 |
 *
 * 三档策略（对齐 legacy 的 `AcceptancePolicy`）：
 * - `auto`：只跑能自动验的；全是 human 的直接通过（危险，慎用）
 * - `unverified_only`：**默认**。自动验能判定的就判定，只剩 human 的才留给人
 * - `always_human`：一律等人确认
 *
 * **复核失败直接判 failed，不允许人工覆盖**——否则"验收"就形同虚设，
 * 人一被催就会点通过。
 */

export const ACCEPTANCE_TYPES = ['command', 'diff', 'human'] as const;
export type AcceptanceType = (typeof ACCEPTANCE_TYPES)[number];

export const ACCEPTANCE_POLICIES = ['auto', 'unverified_only', 'always_human'] as const;
export type AcceptancePolicy = (typeof ACCEPTANCE_POLICIES)[number];

export interface Criterion {
  readonly id: string;
  /** 人话描述，展示用。 */
  readonly desc: string;
  readonly type: AcceptanceType;
  /** `command` 类型必填：要重跑的命令。 */
  readonly check?: string;
  /** 超时（毫秒）。默认 120s。 */
  readonly timeoutMs?: number;
}

export const VERDICTS = ['passed', 'failed', 'unverified'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface CriterionResult {
  readonly criterion: Criterion;
  readonly verdict: Verdict;
  /** 为什么是这个结论，必须可读。 */
  readonly note: string;
  /** 复核时实际跑的命令输出摘要（仅 command 类型）。 */
  readonly output?: string;
}

export interface AcceptanceResult {
  readonly verdict: Verdict;
  readonly results: readonly CriterionResult[];
  /** 是否还需要人确认（决定 D 落到 awaiting_review 还是直接 done）。 */
  readonly needsHuman: boolean;
}

/**
 * 解析验收标准。
 *
 * 从模型给的 JSON 里读，非法项直接拒绝而不是静默忽略——
 * 一个拼错的验收标准如果被忽略，就等于没有验收。
 */
export function parseCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: Criterion[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`验收标准第 ${index + 1} 项不是对象`);
    }
    const record = item as Record<string, unknown>;
    const id = String(record.id ?? '').trim();
    const desc = String(record.desc ?? '').trim();
    const type = String(record.type ?? '');

    if (!id) throw new Error(`验收标准第 ${index + 1} 项缺少 id`);
    if (seen.has(id)) throw new Error(`验收标准 id 重复：${id}`);
    if (!desc) throw new Error(`验收标准 ${id} 缺少 desc（要说清验什么）`);
    if (!ACCEPTANCE_TYPES.includes(type as AcceptanceType)) {
      throw new Error(`验收标准 ${id} 的 type 非法：${type}（可选 ${ACCEPTANCE_TYPES.join(' / ')}）`);
    }

    const check = typeof record.check === 'string' ? record.check.trim() : undefined;
    if (type === 'command' && !check) {
      throw new Error(`验收标准 ${id} 是 command 类型，必须提供 check（要重跑的命令）`);
    }

    seen.add(id);
    out.push({
      id,
      desc,
      type: type as AcceptanceType,
      ...(check ? { check } : {}),
      ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
    });
  });

  return out;
}

/**
 * 汇总多个标准的结论。
 *
 * 任一失败 → failed（这一点**不允许被人工覆盖**）；
 * 全部通过 → passed；否则 unverified。
 */
export function combineVerdicts(results: readonly CriterionResult[]): Verdict {
  if (results.some((r) => r.verdict === 'failed')) return 'failed';
  if (results.length > 0 && results.every((r) => r.verdict === 'passed')) return 'passed';
  return 'unverified';
}

/**
 * 按策略决定是否还需要人确认。
 *
 * - `auto`：纯 human 标准也算通过（不推荐，但允许显式选择）
 * - `unverified_only`：只有 unverified 的才留给人
 * - `always_human`：一律留给人
 */
export function needsHumanReview(
  policy: AcceptancePolicy,
  results: readonly CriterionResult[],
): boolean {
  if (policeAllowsAuto(policy, results)) return false;
  if (policy === 'always_human') return true;
  // unverified_only：只把仍需人工判断的项交给人
  return results.some((r) => r.verdict === 'unverified');
}

function policeAllowsAuto(policy: AcceptancePolicy, results: readonly CriterionResult[]): boolean {
  if (policy !== 'auto') return false;
  // auto 策略下，"没有自动可验的项"也视为不需要人
  return !results.some((r) => r.verdict === 'unverified');
}

export function emptyAcceptance(verdict: Verdict = 'unverified'): AcceptanceResult {
  return { verdict, results: [], needsHuman: verdict !== 'passed' };
}
