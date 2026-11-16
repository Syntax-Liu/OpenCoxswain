/**
 * Mandate：一次「接受」所授予的授权。
 *
 * ## 对齐 DSH 的设计（docs/001-domain.zh-CN.md）
 *
 * > **授权（Mandate）** — 一次接受所授予的内容：策略版本、范围、强度、
 * > 匹配的规则、发送者在该来源上的身份，以及来源接收该触发的方式。
 * >
 * > 规则：**不可变**；范围更宽意味着新建一个工单。工单结束不会结束授权：
 * > 只有人的停止才会撤回它，而不再支持它的策略会撤销它。
 *
 * ## 我们之前缺什么
 *
 * 原来只有"权限档位"（readonly / manual / auto / full），它是**动作级**的：
 * 每个工具调用时现查一次当前值。
 *
 * 后果：Agent 跑到一半，用户改了权限 —— 旧任务会用**新权限**继续跑。
 * 用户以为"改权限只影响以后"，实际影响了正在进行的那件事。
 *
 * ## 现在
 *
 * 派活时**快照**一份授权，Agent 全程用它。改权限只影响**之后**派的活。
 * 这是"不可变"的实际含义。
 */
import type { PermissionLevel } from '../settings/permission.js';

/**
 * 授权强度。
 *
 * 比权限档位多了一个 `explicit`：**用户明确要求的那件事**，
 * 即使当前档位更严也应该做（"帮我把这个文件删了"不需要再问一遍）。
 */
export type MandateStrength =
  /** 用户直接、明确地要求了。 */
  | 'explicit'
  /** 用户松口了（"你自己看着办"）。 */
  | 'inferred'
  /** 系统按规则自动派的（定时、模板）。**默认只记录不执行**。 */
  | 'automatic';

/** 一次授权的完整快照。 */
export interface Mandate {
  /**
   * 策略版本。
   *
   * 权限设置变了这个数字就变。工单恢复前会比对：
   * 版本不同就要重新校验（见 `revalidate`）。
   */
  readonly policyVersion: number;
  /** 派活时生效的权限档位。**之后改全局权限不影响这个工单。** */
  readonly level: PermissionLevel;
  /** 允许改哪些路径（空 = 不限制在写域层面，但仍受 level 约束）。 */
  readonly scope: readonly string[];
  /** 授权强度。 */
  readonly strength: MandateStrength;
  /** 谁允许的：'user' | 'schedule' | 'template' | 'system'。 */
  readonly grantedBy: string;
  /** 授予时间。 */
  readonly grantedAt: number;
}

/** 创建一份授权快照。 */
export function createMandate(input: {
  readonly level: PermissionLevel;
  readonly scope: readonly string[];
  readonly strength: MandateStrength;
  readonly grantedBy: string;
  readonly policyVersion: number;
  readonly now?: number;
}): Mandate {
  return {
    policyVersion: input.policyVersion,
    level: input.level,
    scope: [...input.scope],
    strength: input.strength,
    grantedBy: input.grantedBy,
    grantedAt: input.now ?? Date.now(),
  };
}

/**
 * 授权是否还成立。
 *
 * ## 为什么不直接作废
 *
 * DSH 的原则：**策略变更不取消正在运行的工作**——
 * 被取消的变更会留下半途而废的工作。所以变更只记录并投递，
 * 工单继续跑，但**恢复前要重新校验**。
 *
 * 这里同理：
 * - `stillValid: true`  → 继续
 * - `stillValid: false` → 工单恢复时需要用户重新确认
 */
export function revalidate(
  mandate: Mandate,
  current: { readonly level: PermissionLevel; readonly policyVersion: number },
): { readonly stillValid: boolean; readonly reason?: string } {
  if (mandate.policyVersion === current.policyVersion) {
    return { stillValid: true };
  }

  // 版本变了：权限可能收紧了。
  // 判断标准是**有没有变严**——放松不算问题。
  const order: Record<PermissionLevel, number> = {
    readonly: 0,
    manual: 1,
    auto: 2,
    full: 3,
  };
  if (order[current.level] >= order[mandate.level]) {
    return { stillValid: true };
  }

  return {
    stillValid: false,
    reason:
      `权限档位从「${mandate.level}」收紧到了「${current.level}」，` +
      '这个任务是在旧档位下授权的，继续前需要你确认。',
  };
}
