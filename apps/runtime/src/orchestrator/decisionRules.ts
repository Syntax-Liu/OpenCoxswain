/**
 * 什么才算「需要用户拍板」。
 *
 * ## 为什么需要这个判据
 *
 * 实测发现：界面上 5 条「待决策」里 3 条根本不是决策——
 * "Agent 未完成"、"结论：这个项目是……" 都被标成了待决策。
 *
 * 根因是一行代码：`needsUser: !ok`。
 * **Agent 没成功 ≠ 需要用户决定。**
 *
 * 面板本身没问题，但里面混着噪音，用户很快就会学会忽略它——
 * 那个好不容易建起来的介入点就废了。
 *
 * ## 判据
 *
 * 只有这几种才算：
 *
 * | 情况 | 为什么 |
 * | --- | --- |
 * | `blocked`（卡住） | Agent 明确说"我做不下去了，需要你" |
 * | 用量/预算中止 | 要不要继续，只有用户能定 |
 * | Assistant 明确提问 | `report_to_user` 带 `needsUser: true` |
 * | 需要用户在外部操作 | 凭证、授权、线下确认 |
 *
 * 这些**不算**：
 *
 * - 普通失败（能自己重试、或改个做法就行）
 * - 完成汇报（哪怕带了待办建议）
 * - 进度更新
 *
 * ## 一个原则
 *
 * **宁可少标，不可多标。**
 * 漏标一条，用户晚点自己会发现；
 * 多标十条，用户以后就再也不看这个面板了。
 */

import type { ReportKind } from '../store/store.js';

/** 报告的各种来源。 */
export interface DecisionContext {
  readonly kind: ReportKind;
  /** 报告正文。 */
  readonly body: string;
  /**
   * 调用方是否**显式**要求用户介入。
   *
   * - `undefined`：调用方没表态，交给下面判断
   * - `true`：调用方明确要用户介入
   * - `false`：调用方明确说不需要
   */
  readonly explicit?: boolean;
}

/** 判断正文里是否有"真的在请求用户做事"的措辞。 */
function asksUserToAct(body: string): boolean {
  // **"请确认"要出现在句子开头才算请求**。
  //
  // 反例（真实误判）：
  //   "如果这个告警来自别处，请确认来源"
  // 那是建议，不是请求用户现在去做事。
  //
  // 正例：
  //   "请确认仓库地址是否正确"
  //   "需要你提供 token"
  return /(?:^|[。！？\n]\s*)(?:请|需要你)(?:提供|确认|授权|登录|告知)/.test(body);
}

/**
 * 判断一条报告是否真的需要用户拍板。
 *
 * 返回 `false` 的报告仍会记录、仍会展示，只是**不进入待决策面板**。
 */
export function needsUserDecision(ctx: DecisionContext): boolean {
  // 调用方明确表态时，尊重它
  if (ctx.explicit !== undefined) return ctx.explicit;

  // 用量中止：是否继续只有用户能定（不限于 blocked）
  if (/用量上限|预算|止损线/.test(ctx.body)) return true;

  // **卡点分类标记**：结算里写着"[卡点分类：需用户决定]"的，
  // 说明系统判断这确实是需要人拍板的事，只是 kind 记成了 failed。
  // 只看 kind 会漏掉它——真实数据里这类一条都没有 blocked。
  if (/卡点分类[：:]\s*需用户决定/.test(ctx.body)) return true;

  // 需要用户在外部做事
  if (asksUserToAct(ctx.body)) return true;

  // 卡住：Agent 自己做不下去了
  if (ctx.kind === 'blocked') return true;

  // **其它一律不算**——包括普通失败、完成汇报、进度更新
  return false;
}

/**
 * 给待决策的正文加一个**可操作的**开头，方便用户快速抓住要点。
 *
 * 面板上每行只显示一行，所以第一句必须能让人立刻判断"要不要管"。
 * 早期实现直接把正文第一句拿来用，结果常显示成
 * "## 结论 我倾向先做 B…" 这种，看不出到底在问什么。
 */
export function decisionLead(kind: ReportKind, body: string): string {
  // **先看具体原因，再看大类**。
  // 顺序反了的话，blocked 会把"用量上限"这种更有信息量的原因盖掉。
  if (/用量上限|预算|止损线/.test(body)) return '达到用量上限，要不要继续';
  if (asksUserToAct(body)) return '需要你在外部做一件事';
  if (kind === 'blocked') return '卡住了，需要你决定怎么往下走';
  return '等你拍板';
}
