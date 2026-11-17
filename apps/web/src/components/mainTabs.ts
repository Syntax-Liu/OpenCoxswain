/**
 * 主区标签页（照 DSH）。
 *
 * ## 为什么要有标签
 *
 * 用户的原话：
 *
 * > 既然做了，那就像 DSH 这样吧，侧边栏可以放多个页面
 *
 * DSH 的截图里顶部是一排标签：
 *
 *   │ 第 240 轮改动 × │ OpenCoxswain 0.116.2 │
 *
 * 点「改动」就为那一轮开一个标签，**同时能开着好几个**，
 * 来回切不用重新加载。这比"点开就在原地替换"强得多——
 * 对比两轮的改动时不需要来回找。
 *
 * ## 标签和视图的关系
 *
 * 标签是**主区显示什么**的栈。主区同一时刻只显示一个标签的内容，
 * 但标签本身不销毁（切回去数据还在）。
 */

/** 一个主区标签。 */
export interface MainTab {
  /** 稳定 id，用来去重和关闭。 */
  readonly id: string;
  readonly kind: 'chat' | 'change';
  /** 标签上显示的文字。 */
  readonly title: string;
  /** 改动标签对应的 Agent（一次派活 = 一轮）。 */
  readonly executorId?: string;
}

/** 对话标签的固定 id。切回对话的时候用它。 */
export const CHAT_TAB_ID = 'chat';

/**
 * 开一个标签。
 *
 * 同 id 的已经开着就**只切过去、不重复开**——否则点两次就有两个一样
 * 的标签，关起来很烦。
 */
export function openTab(tabs: readonly MainTab[], tab: MainTab): MainTab[] {
  const existing = tabs.find((t) => t.id === tab.id);
  if (existing) return [...tabs];
  return [...tabs, tab];
}

/** 关一个标签。对话标签不能关（总得有个落脚的地方）。 */
export function closeTab(tabs: readonly MainTab[], id: string): MainTab[] {
  if (id === CHAT_TAB_ID) return [...tabs];
  return tabs.filter((t) => t.id !== id);
}

/**
 * 关掉一个标签后该切到哪。
 *
 * 关掉的正是当前标签时，切到**左边邻居**；左边没有就切到右边；
 * 都没有就回对话。
 */
export function tabAfterClose(
  tabs: readonly MainTab[],
  closedId: string,
  activeId: string,
): string {
  if (closedId !== activeId) return activeId;
  const index = tabs.findIndex((t) => t.id === closedId);
  if (index < 0) return CHAT_TAB_ID;
  const neighbor = tabs[index - 1] ?? tabs[index + 1];
  return neighbor?.id ?? CHAT_TAB_ID;
}

/** 一轮改动的标签文案：`第 3 轮改动`（按打开顺序编号更贴近用户认知）。 */
export function changeTabTitle(index: number): string {
  return `第 ${index} 轮改动`;
}
