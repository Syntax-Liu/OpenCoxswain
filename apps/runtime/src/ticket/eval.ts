/**
 * Eval：判断这条消息该做什么。
 *
 * ## 对齐 DSH 的设计（docs/001-domain.zh-CN.md）
 *
 * > **评估（Eval）** — 对一批触发的判断，分两层：准入与研判。
 * > 输入：触发批次、线程快照、该线程上的所有工单（含已结束的），
 * > 以及当前策略。输出：一个决定。
 * > **决定新工作是开始、继续还是停止。**
 *
 * 决定的取值：accept（接受）、stop（停止）、ignore（忽略）、unavailable（不可用）。
 *
 * ## 我们之前缺什么
 *
 * Assistant 收到消息**直接行动**。后果：
 *
 *   用户："这个想法不错，可以考虑一下"  → 立刻派 Agent 去干
 *   用户："算了，先这样"                → 当成新任务理解
 *   用户："你好"                        → 可能也去派活
 *
 * ## 这里做什么
 *
 * 一个**规则优先**的分类器：明显的情况直接判（不花模型调用），
 * 拿不准的交给 Assistant 自己判断。
 *
 * **为什么不全部交给模型**：分类是高频动作，每次调一次模型很贵；
 * 而且"算了""不用了"这种明确的停止信号，规则比模型更可靠。
 */
import { makeTrigger } from '../orchestrator/trigger.js';

/**
 * 一条消息的处理决定。
 *
 * 对齐 DSH 的四种：accept / stop / ignore / unavailable。
 */
export type EvalDecision =
  /** 新工作：该派 Agent 或 Assistant 自己动手。 */
  | 'accept'
  /** 停止：用户要停下来。 */
  | 'stop'
  /** 忽略：不是要给 agent 的指令（客套、感叹）。 */
  | 'ignore'
  /** 拿不准：交给 Assistant 自己判断。 */
  | 'defer';

export interface EvalResult {
  readonly decision: EvalDecision;
  /** 为什么这么判（给用户看，也用于审计）。 */
  readonly reason: string;
  /** 是否由规则直接判定（true = 没花模型调用）。 */
  readonly byRule: boolean;
}

/**
 * 明确的「停」信号。
 *
 * **这些必须是短句**：句子里出现"取消"不代表要停
 * （"取消订阅后怎么恢复？"是提问，不是停下）。
 */
const STOP_PATTERNS: readonly RegExp[] = [
  /^(?:停|停止|暂停|停下|stop)\s*[！!。.]*$/i,
  /^(?:算了|不用了|先这样|到此为止|不要了)\s*[！!。.]*$/,
  /^(?:都)?(?:停|取消)(?:掉|了|一下)?\s*(?:吧|啊|哈)?\s*[！!。.]*$/,
  /^(?:别|不用|不要)(?:再)?(?:做|干|派|跑)了?\s*[！!。.]*$/,
];

/** 不需要回应的内容（客套、纯感叹）。 */
const IGNORE_PATTERNS: readonly RegExp[] = [
  /^(?:谢谢|多谢|感谢|thanks|thx)\s*[！!。.]*$/i,
  /^(?:好的?|嗯|ok|okay|收到|了解|明白)\s*[！!。.]*$/i,
  /^(?:哈哈+|233+)\s*[！!。.]*$/,
];

/**
 * 「继续现有任务」的信号。
 *
 * 这类不该新派 Agent，而该 message_executor 给正在跑的那个。
 */
const CONTINUE_PATTERNS: readonly RegExp[] = [
  /^(?:继续|接着|然后呢|下一步)/,
  /^(?:再)?(?:加|补|改)(?:上|一下|一下下)?/,
];

/** 停信号要够短：长句里的"停"多半是提问。 */
const MAX_STOP_LENGTH = 12;

/**
 * 判断一条消息。
 *
 * @param text 用户原话
 * @param runningCount 当前在跑的 Agent 数量
 */
export function evaluate(text: string, runningCount = 0): EvalResult {
  const t = text.trim();

  if (!t) {
    return { decision: 'ignore', reason: '空消息', byRule: true };
  }

  // ---- 1. 停 ----
  //
  // 只在**有 Agent 在跑**时才算"停"。
  // 没有在跑的活，用户说"算了"多半是在说别的事。
  if (runningCount > 0 && t.length <= MAX_STOP_LENGTH) {
    for (const re of STOP_PATTERNS) {
      if (re.test(t)) {
        return {
          decision: 'stop',
          reason: '用户要停下来',
          byRule: true,
        };
      }
    }
  }

  // ---- 2. 忽略 ----
  for (const re of IGNORE_PATTERNS) {
    if (re.test(t)) {
      return {
        decision: 'ignore',
        reason: '客套话，不需要行动',
        byRule: true,
      };
    }
  }

  // ---- 3. 继续现有 ----
  if (runningCount > 0) {
    for (const re of CONTINUE_PATTERNS) {
      if (re.test(t)) {
        return {
          decision: 'defer',
          reason: '像是接着现有任务说话，交给 Assistant 判断该发给哪个 Agent',
          byRule: true,
        };
      }
    }
  }

  // ---- 4. 其余交给模型 ----
  //
  // 不做关键词猜测。分类错了比不做更糟：
  // 用户说"帮我把这个删了"被误判成 闲聊 会很难受。
  return {
    decision: 'defer',
    reason: '规则判不了，交给 Assistant 自己判断',
    byRule: false,
  };
}

/**
 * 把一个状态变化包成 trigger（供上面 evaluate 之外的场景用）。
 *
 * 这里只是把 `orchestrator/trigger.ts` 的工厂再导出一个名字，
 * 避免调用点要 import 两个模块。
 */
export { makeTrigger };
