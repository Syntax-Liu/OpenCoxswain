/**
 * 首次使用的引导内容。
 *
 * ## 为什么需要
 *
 * 填完密钥进到主界面，眼前是一个空对话 + 一个空输入框。
 * 用户不知道：
 * - 这个软件和普通聊天机器人有什么不一样
 * - 该打什么
 * - 「让它干活」到底怎么触发
 *
 * 引导的作用不是教学，是**给三条可以直接点的例子**——
 * 点了就有任务在跑，用户立刻明白它是怎么工作的。
 *
 * ## 只显示一次
 *
 * 用 localStorage 记一个标记。用户点过任意一条、或手动关掉，
 * 就再也不出现。**不再问第二次**。
 */

/** 示例任务。 */
export interface StarterExample {
  readonly id: string;
  readonly title: string;
  /** 点下去实际发送的文本。 */
  readonly prompt: string;
  readonly hint: string;
}

/** 三条示例：一条简单、一条要查代码、一条能体现并发。 */
export const STARTER_EXAMPLES: readonly StarterExample[] = [
  {
    id: 'explain',
    title: '介绍一下这个项目',
    prompt: '先通读项目结构和 README，然后用三句话说明这个项目是做什么的。',
    hint: '最简单的开始：它会自己去读文件',
  },
  {
    id: 'find',
    title: '找出可以改进的地方',
    prompt: '通读 src 下的代码，找出三个最值得改进的地方，每条说明理由和影响。',
    hint: '会派出 Agent 去读代码',
  },
  {
    id: 'parallel',
    title: '同时做两件独立的活',
    prompt: '并行做两件事：一是整理根目录下的文档，二是检查有没有明显的拼写错误。做完分别汇报。',
    hint: '体验并发：两个 Agent 同时跑，谁先完成谁先报',
  },
];

const SEEN_KEY = 'ocx.onboarding.seen';

/** 是否该显示引导。localStorage 不可用时**不显示**（宁可不打扰）。 */
export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== '1';
  } catch {
    return false;
  }
}

/** 标记引导已看过（点了示例或手动关闭）。 */
export function markOnboardingSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // 存不进去就算了，下次还会显示——不影响功能
  }
}

/** 重置（测试与"重新看一遍引导"用）。 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch {
    /* 忽略 */
  }
}
