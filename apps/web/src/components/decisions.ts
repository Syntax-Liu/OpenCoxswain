/**
 * 待决策事项。
 *
 * ## 为什么单独做一个模块
 *
 * 半自动自进化的条件 S3 是"人只参与重大决策"。
 * 但现在 Assistant 说"需要你决定"时，**界面上和普通回复一模一样**——
 * `needsUser` 字段存了、能过滤、全局概览会统计，
 * 唯独对话流里没有任何视觉区分。
 *
 * 结果是：用户得自己从几十条消息里认出"哦，这条是在问我"。
 * 而那恰恰是**唯一需要他动脑的地方**，却埋得最深。
 *
 * ## 这个模块管什么
 *
 * - 哪些报告是"待决策"（未确认 + needsUser）
 * - 怎么把它们排到最显眼的位置
 * - 确认后怎么从待办里消失
 *
 * 不管渲染——UI 只管用这里的结果。
 */
import type { ReportDto } from '../api.js';

/** 一条待决策事项。 */
export interface PendingDecision {
  readonly id: string;
  readonly projectId: string;
  /** 决策正文（Assistant 提出的问题或选项）。 */
  readonly body: string;
  /** 什么时候提的。 */
  readonly at: number;
  /** 来自哪个 Agent；null 表示 Assistant 自己提的。 */
  readonly executorId: string | null;
}

/**
 * 判断一条报告是不是**还没处理**的待决策。
 *
 * 三个条件：
 * - `needsUser` 为真（Assistant 明确说要人拍板）
 * - 还没被确认（`ackedAt` 为空）
 * - 不是进度类（`kind === 'question'`，或者 needsUser 就算）
 *
 * 注意 `blocked` 也算——Agent 卡住了同样需要人。
 */
export function isPendingDecision(report: ReportDto): boolean {
  return report.needsUser && report.ackedAt === null;
}

/**
 * 从报告列表里筛出待决策，**最新的排最前**。
 *
 * 最新的排前面：用户刚被问了什么，比三天前的问题更要紧。
 */
export function pendingDecisions(reports: readonly ReportDto[]): PendingDecision[] {
  return reports
    .filter(isPendingDecision)
    .map((r) => ({
      id: r.id,
      projectId: r.projectId,
      body: r.body,
      at: r.at,
      executorId: r.executorId,
    }))
    .sort((a, b) => b.at - a.at);
}

/**
 * 待决策事项的一句话摘要。
 *
 * 面板上每行只显示一行，所以要把多行正文压成一行，
 * 并且**保留最有信息量的开头**——用户常见的问题都在第一句。
 */
export function summarizeDecision(body: string, limit = 80): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return oneLine.slice(0, limit - 1) + '…';
}

/**
 * 生成"待决策"面板的标题。
 *
 * 有一条时说"1 件事等你决定"，多条时给数量。
 * **不做"全部处理"按钮**——这些是决策，不是一个批量操作。
 */
export function decisionPanelTitle(count: number): string {
  if (count <= 0) return '';
  return `${count} 件事等你决定`;
}

/**
 * 判断某条报告是否属于"已经处理过"。
 *
 * 用于在对话流里给已确认的决策打上"已处理"标记——
 * **不能让它消失**：用户可能要回头查"当时我是怎么决定的"。
 */
export function isAckedDecision(report: ReportDto): boolean {
  return report.needsUser && report.ackedAt !== null;
}
