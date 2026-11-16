/**
 * 颜色语义表。
 *
 * ## 为什么需要
 *
 * 界面里颜色用得随意：待决定圆点、结论链接、任务状态点、
 * 压缩警告图标、闪电图标都用琥珀色——**一个颜色承担 5 种含义**。
 *
 * 结果是想表达"这里需要你注意"时，已经没有更强的颜色可用了。
 *
 * ## 规则
 *
 * | 颜色 | 只用于 |
 * | --- | --- |
 * | 琥珀 accent | **需要用户操作**（待决策、可直接点的链接） |
 * | 青色 info | 中性信息、进度 |
 * | 绿色 success | 成功完成 |
 * | 红色 danger | 失败、危险动作 |
 * | 灰色 muted | 未开始、已取消、辅助信息 |
 *
 * ## 关键约束
 *
 * **琥珀不能用于装饰。** 图标、分隔线、容器背景都不许用——
 * 否则"需要操作"这个信号会被稀释，用户就不再敏感了。
 */

/** 界面里每种视觉状态该用什么语义色。 */
export type SemanticTone =
  | 'action'   // 需要用户操作
  | 'info'     // 中性信息
  | 'success'  // 成功
  | 'danger'   // 失败 / 危险
  | 'muted'    // 未开始 / 已取消 / 辅助
  | 'neutral'; // 普通正文

/** 各语义对应的 CSS 变量名。 */
export const TONE_VAR: Record<SemanticTone, string> = {
  action: '--accent',
  info: '--info',
  success: '--ok',
  danger: '--danger',
  muted: '--text-dim',
  neutral: '--text',
};

/**
 * 把界面状态映射到语义色。
 *
 * 这些映射是**唯一权威**——新加状态时先查表，不要自己挑颜色。
 */
export function toneForStatus(status: string): SemanticTone {
  switch (status) {
    case 'running':
    case 'starting':
      return 'action';
    case 'queued':
      return 'info';
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    case 'cancelled':
      return 'muted';
    case 'handback':
      // **不是 danger**：交回不是失败。
      // 用 info 表示"有情况要你注意"，但它是好消息——
      // Agent 发现了问题在别处，省了你去踩坑。
      return 'info';
    default:
      return 'muted';
  }
}

/** 判断一个元素是不是"需要用户操作"，决定能不能用琥珀色。 */
export function canUseAccent(kind: 'action' | 'decoration' | 'container' | 'status'): boolean {
  // **只有 action 类可以用琥珀**。装饰、容器、普通状态一律不行。
  return kind === 'action';
}
