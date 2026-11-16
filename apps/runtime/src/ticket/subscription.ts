/**
 * Subscription：消息自动抵达正在跑的 Agent。
 *
 * ## 对齐 DSH 的设计（docs/001-domain.zh-CN.md）
 *
 * > **订阅（Subscription）** — 工单与线程之间的多对多关系。
 * >
 * > 规则：匹配的触发会**扇出给每一个存活的已订阅工单**，不检查发送者是谁；
 * > **通过这种方式抵达工单的人的消息不进入评估**。
 * > 已结束的工单保留其订阅：人的消息会在同一授权下使其恢复。
 * > **被人停止的工单不接收任何内容。**
 *
 * 存在的原因：*后续讨论无需任何人再次 @ agent 就能抵达执行器。*
 *
 * ## 我们之前缺什么
 *
 * 用户派了一个 Agent，然后想说"再加个条件"——现在必须：
 *   进 Agent 页面 → 在它的输入框里说
 *
 * 如果直接在项目对话里说，Assistant 可能**又派一个新 Agent**，
 * 而原来的还在跑，两个 Agent 干重叠的活。
 *
 * ## 我们的简化版
 *
 * DSH 的"线程"是跨来源的（GitHub PR、飞书话题…）。我们没有多来源，
 * 所以**线程 = 项目的一次对话**（session）。
 *
 * 订阅规则：
 *   - 有**唯一**一个 Agent 在跑 → 这条消息自动投给它（不派新的）
 *   - 有**多个**在跑 → 不猜，交给 Assistant 判断
 *   - 没有在跑 → 正常流程（Eval → Assistant）
 *
 * 为什么多个不猜：投错了比不投更糟——用户说的话进了错误的 Agent，
 * 那个 Agent 会照做，而真正该做的那个没收到。
 */

/** 一条用户消息的投递目标。 */
export type SubscriptionTarget =
  /** 投给这个具体的 Agent（唯一在跑时）。 */
  | { readonly kind: 'executor'; readonly executorId: string; readonly reason: string }
  /** 不投给具体 Agent，走正常流程。 */
  | { readonly kind: 'none'; readonly reason: string };

export interface RunningExecutor {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

/**
 * 判断这条消息该不该自动投给某个 Agent。
 *
 * @param running 当前项目的 Agent 列表（含各种状态）
 * @param text    用户说的话
 */
export function routeToSubscriber(
  running: readonly RunningExecutor[],
  text: string,
): SubscriptionTarget {
  // "被人停止的工单不接收任何内容"（DSH 原规则）。
  // cancelled 的 Agent 不该再收消息——它已经被人叫停了。
  const live = running.filter((e) => e.status === 'running' || e.status === 'starting');

  if (live.length === 0) {
    return { kind: 'none', reason: '没有 Agent 在跑' };
  }

  if (live.length > 1) {
    return {
      kind: 'none',
      reason: `有 ${live.length} 个 Agent 在跑，投给谁不明确——交给 Assistant 判断`,
    };
  }

  const only = live[0]!;

  // **明显在指别的东西时不投**。
  //
  // 用户说"再派一个 Agent 查 X" 时，他想要的是**新任务**，
  // 不是给正在跑的那个加活。这类必须留给 Eval → Assistant。
  if (looksLikeNewTask(text)) {
    return {
      kind: 'none',
      reason: '这句话像是在要一件新的事，不给现有 Agent 加活',
    };
  }

  return {
    kind: 'executor',
    executorId: only.id,
    reason: `唯一在跑的 Agent「${only.label}」，这句话作为补充指令转给它`,
  };
}

/**
 * 这句话是不是在要一件**新**的事。
 *
 * 判据保守：只在有明确"再开一个"信号时才判新任务。
 * 误判成新任务的代价是"用户想补充却被派了新 Agent"，
 * 误判成补充的代价是"用户想新任务却被塞给旧 Agent"——
 * 两者都烦人，所以**默认按补充处理**（这正是订阅的目的）。
 */
function looksLikeNewTask(text: string): boolean {
  const t = text.trim();
  const patterns: readonly RegExp[] = [
    /(?:再|另外|单独|重新)\s*(?:派|开|起|建)\s*(?:一个|个)?\s*(?:新)?\s*(?:Agent|agent|任务|会话)/i,
    /(?:^|[。！？\n])\s*(?:新任务|新的任务)[:：]/,
    /派\s*(?:一个|个)\s*(?:新)?\s*(?:Agent|agent)/i,
  ];
  return patterns.some((re) => re.test(t));
}
