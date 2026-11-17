/**
 * 失败后的出路（UD-03 的替代方案）。
 *
 * ## 为什么不叫"重试"
 *
 * 原本 UD-03 想要的是「从失败的那一步重试」。查证后发现**做不到真实**：
 *
 * | 需要 | 现状 |
 * | --- | --- |
 * | 第 N 步之前的文件状态 | ✅ 有（`snapshot.ts`） |
 * | 回滚一批文件 | ✅ 有（`rollbackCheckpoint`） |
 * | **当时的对话上下文** | ❌ 消息表只追加，无版本化，没有"第 N 步时模型看到了什么" |
 * | **循环中间状态** | ❌ 全在内存，不落盘 |
 *
 * `Checkpoint` 是「一批文件改动的时间窗」，不是「可恢复的执行状态」。
 * 带全量历史重跑的话，模型会看到一个自相矛盾的世界：
 * 文件是旧的，但它记得自己已经改过了。**那是幻觉，不是重试。**
 *
 * 所以这里做的是**如实告诉用户现在能做什么**，每一项都接真实能力。
 *
 * 参考 [design-research/03 B3](../../../docs/design-research/03-agent-ui-problems.md)
 * 与 [ui-dev-guide](../../ui-dev-guide.md) 的"不伪造"原则。
 */

export type RecoveryKind = 'rollback' | 'ask' | 'resend';

export interface RecoveryOption {
  readonly kind: RecoveryKind;
  /** 按钮文字。 */
  readonly label: string;
  /** 一句话说明这个选项会做什么（放在 tooltip 里）。 */
  readonly hint: string;
}

export interface RecoveryContext {
  /** 副作用台账里有可撤销的文件改动。 */
  readonly hasReversibleEffects: boolean;
  /** 当前 Agent 支持续聊（可以接着跟它说）。 */
  readonly canResume: boolean;
}

/**
 * 列出当前**真正可用**的出路。
 *
 * 铁律：**不可用的不返回，而不是返回一个 disabled 的按钮。**
 * 禁用态容易被误解成"以后会可用"，隐藏更诚实。
 */
export function recoveryOptions(ctx: RecoveryContext): readonly RecoveryOption[] {
  const options: RecoveryOption[] = [];

  // 回滚：只有真有可撤销的改动时才出现
  if (ctx.hasReversibleEffects) {
    options.push({
      kind: 'rollback',
      label: '回滚改动',
      hint: '把这次改动过的文件恢复到之前的样子，不会动你的对话',
    });
  }

  // 续聊：Agent 还在、还能接话
  if (ctx.canResume) {
    options.push({
      kind: 'ask',
      label: '接着跟它说',
      hint: '打开这个 Agent，带着刚才的上下文继续',
    });
  }

  // 重新发起：**永远可用**，且永远不假装"重试同一步"
  options.push({
    kind: 'resend',
    label: '重新说一次',
    hint: '回到输入框，把要求重新提一遍（会当作新一轮任务）',
  });

  return options;
}
