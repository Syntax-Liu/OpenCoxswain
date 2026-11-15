/**
 * 输入区提示：告诉用户"现在能不能继续说话"。
 *
 * ## 为什么需要
 *
 * 技术上我们一直允许连发（"连发不打断"是产品承诺），
 * 但**界面上完全没暗示**。
 *
 * 用户看到 Agent 在跑，会本能地等它跑完再发——这浪费了并发能力，
 * 也正是这个产品想解决的场景（一口气派三件事）。
 *
 * ## 提示的分寸
 *
 * 不能太吵。它是**解释**，不是警告：
 * - 只在真有 Agent 在跑 / Assistant 在思考时出现
 * - 一句话，不占地方
 * - 不用醒目色（不是警报）
 */

/** 输入区提示的状态。 */
export interface ComposerHint {
  readonly text: string;
  /** 提示的语气；quiet 表示"顺口说一句"，不抢注意力。 */
  readonly tone: 'quiet' | 'active';
}

/**
 * 生成输入区提示。
 *
 * 返回 null 表示不显示——空闲时不需要任何提示。
 */
export function composerHint(input: {
  readonly thinking: boolean;
  readonly runningAgents: number;
}): ComposerHint | null {
  if (input.runningAgents > 0) {
    const count = input.runningAgents;
    return {
      text: `${count} 个 Agent 在跑，你可以继续说——新消息会排队，不会打断它们`,
      tone: 'active',
    };
  }

  if (input.thinking) {
    return {
      text: '正在处理，你可以继续说——不会打断它',
      tone: 'quiet',
    };
  }

  return null;
}
