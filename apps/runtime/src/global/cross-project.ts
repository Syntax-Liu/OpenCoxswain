/**
 * 跨项目冲突检测。
 *
 * ## 为什么需要
 *
 * 项目内的写域互斥（`Gate`）只看**相对路径**。两个互不相干的项目都有 `src/`，
 * 但那不是冲突。真正的问题是：
 *
 * ```
 * 项目 A 的 Agent 在改 D:\shared\utils\strings.ts
 * 项目 Supervisor 的 Agent 也在改 D:\shared\utils\strings.ts
 * → 后写的覆盖先写的，两边台账都显示"成功"
 * ```
 *
 * 这种情况现在**没有任何防护**，会造成真实的数据损坏，
 * 而且事后两个项目都以为自己做对了。
 *
 * ## 做法
 *
 * 把每个 Agent 的写域解析成**绝对路径**（项目根 + 相对路径），
 * 再比较不同项目的绝对路径是否重叠。
 *
 * 只关心**跨项目**的冲突：同项目内已经由 `Gate` 处理。
 */
import path from 'node:path';

export interface AgentClaim {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly agentId: string;
  readonly label: string;
  /** 相对项目根的写域；空数组或 `["readonly"]` 表示不写。 */
  readonly writeScope: readonly string[];
  readonly readonly: boolean;
}

export interface CrossProjectConflict {
  readonly withProjectId: string;
  readonly withAgentId: string;
  readonly withLabel: string;
  /** 重叠的绝对路径前缀，展示给用户。 */
  readonly overlap: string;
}

/** 把相对写域解析成归一化的绝对路径。 */
function resolveScopes(claim: AgentClaim): string[] {
  if (claim.readonly) return [];
  const root = path.resolve(claim.projectRoot);

  // 去掉只读约定
  const scopes = claim.writeScope.filter((s) => s !== 'readonly');

  // 空写域表示"整个项目"：用根目录代表。
  // 早期这里直接 map，空数组永远解析不出东西，等于漏掉了最危险的一种情况——
  // 一个不声明写域的 Agent 其实可以写项目里任何地方。
  if (scopes.length === 0) return [normalize(root)];

  return scopes
    .map((s) => (s.trim() === '' ? root : path.resolve(root, s)))
    .map(normalize);
}

function normalize(p: string): string {
  // 统一分隔符与大小写（Windows 大小写不敏感）
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 两个绝对路径是否重叠（一个是另一个的前缀）。 */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * 检查某个 Agent 的写域是否与**其它项目**在跑的 Agent 冲突。
 *
 * @returns 冲突信息；无冲突返回 null。
 */
export function findCrossProjectConflict(
  candidate: AgentClaim,
  running: readonly AgentClaim[],
): CrossProjectConflict | null {
  if (candidate.readonly) return null;

  const mine = resolveScopes(candidate);
  if (mine.length === 0) return null;

  for (const other of running) {
    // 同项目交给 Gate 处理，这里不管
    if (other.projectId === candidate.projectId) continue;
    if (other.readonly) continue;

    const theirs = resolveScopes(other);
    for (const a of mine) {
      for (const b of theirs) {
        if (overlaps(a, b)) {
          return {
            withProjectId: other.projectId,
            withAgentId: other.agentId,
            withLabel: other.label,
            overlap: a.length <= b.length ? a : b,
          };
        }
      }
    }
  }
  return null;
}

/**
 * 从所有在跑的执行者里构造 AgentClaim 列表。
 *
 * 由调用方（Orchestrator）提供数据，这个模块不依赖存储层，便于单测。
 */
export function toClaim(input: {
  projectId: string;
  projectRoot: string;
  agentId: string;
  label: string;
  writeScope: readonly string[];
  readonly: boolean;
}): AgentClaim {
  return input;
}

/** 把冲突写成人话（给用户/Assistant看）。 */
export function describeConflict(conflict: CrossProjectConflict): string {
  return (
    `与另一个项目的执行者「${conflict.withLabel}」写同一个位置：\n` +
    `  ${conflict.overlap}\n` +
    '两个项目同时改同一份文件会互相覆盖，而且事后两边都以为成功了。'
  );
}
