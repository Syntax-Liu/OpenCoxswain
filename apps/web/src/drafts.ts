/**
 * 草稿保存。
 *
 * ## 为什么需要
 *
 * 用户打了一半，切到别的项目看一眼，切回来输入框空了——东西丢了。
 * 这是最容易被骂"难用"的一类问题，而实现成本很低。
 *
 * ## 存储策略
 *
 * 按**视图**分开存：同一个项目，对 Assistant 说的和某个 Agent 说的
 * 是两份草稿，不能串。
 *
 * 用 localStorage 而不是内存：关掉软件再打开，草稿还在。
 * 这是用户对"草稿"这个词的预期。
 */

const STORAGE_PREFIX = 'ocx.draft.';

/** 草稿的最大长度：太长的多半是误粘贴，没必要存。 */
export const MAX_DRAFT_LENGTH = 20_000;

/** 生成某个视图的存储键。 */
export function draftKey(view: {
  readonly kind: string;
  readonly projectId?: string;
  readonly executorId?: string;
}): string {
  if (view.kind === 'executor' && view.executorId) {
    return `${STORAGE_PREFIX}executor.${view.executorId}`;
  }
  if (view.kind === 'assistant' && view.projectId) {
    return `${STORAGE_PREFIX}assistant.${view.projectId}`;
  }
  return `${STORAGE_PREFIX}global`;
}

/** 读草稿。读不到或坏数据都返回空串。 */
export function loadDraft(key: string): string {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return '';
    return raw.length > MAX_DRAFT_LENGTH ? raw.slice(0, MAX_DRAFT_LENGTH) : raw;
  } catch {
    // localStorage 可能被禁用（隐私模式）；草稿丢了也不能让界面崩
    return '';
  }
}

/** 存草稿。空内容直接删掉，不留垃圾键。 */
export function saveDraft(key: string, text: string): void {
  try {
    if (!text.trim()) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, text.slice(0, MAX_DRAFT_LENGTH));
  } catch {
    // 存不进去就算了，不影响主流程
  }
}

/** 清掉某个视图的草稿（发送成功后调用）。 */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}
