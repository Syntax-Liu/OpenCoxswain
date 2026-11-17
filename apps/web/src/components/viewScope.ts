/**
 * 「当前是不是某个项目的页面」。
 *
 * ## 为什么抽出来
 *
 * 这个判断原本内联在 `App.tsx` 里：
 *
 *     const inProject = currentProject !== null &&
 *       (view?.kind === 'assistant' || view?.kind === 'executor');
 *
 * 它出过一次真实的 bug：`hasRailContent` 里只写了 `view?.kind === 'assistant'`，
 * 漏了 `executor`，导致 **Agent 页的右栏整块不渲染**，
 * 用户看到的症状是「Assistant 页面有分隔线，Agent 页面没有」。
 *
 * 当时的测试是靠正则去 `App.tsx` 里找变量名：
 *
 *     assert.match(app, /const hasRailContent =[\s\S]{0,200}/);
 *
 * 这种测试能防住"又写死 assistant"，但**防不住等价的重构**——
 * 换个变量名它就红，逻辑真错了（只要名字还在）它反而绿。
 *
 * 抽成纯函数之后，测试测的是判断本身，与变量名无关。
 */

/** 页面类型：只看这两个算"项目内页面"。 */
export type InProjectView = { readonly kind: string } | null | undefined;

/**
 * 当前是否在项目内页面（Assistant 页 或 Agent 页）。
 *
 * 两者必须**同等待遇**——这正是当初 bug 的根源。
 */
export function isInProject(
  currentProject: unknown,
  view: InProjectView,
): boolean {
  return currentProject !== null && currentProject !== undefined &&
    (view?.kind === 'assistant' || view?.kind === 'executor');
}

/**
 * 右栏该不该显示。
 *
 * 两条路径：有待决策的报告，或者正处在项目内页面。
 */
export function hasRail(
  currentProject: unknown,
  view: InProjectView,
  reports: readonly { needsUser: boolean; ackedAt: number | null }[],
): boolean {
  if (reports.some((r) => r.needsUser && r.ackedAt === null)) return true;
  return isInProject(currentProject, view);
}
