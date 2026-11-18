/**
 * 高影响动作的「首次提示」（UD-05）。
 *
 * ## 为什么
 *
 * 参考 设计约束：
 *
 * > 首次启动点过"同意"，之后 Agent 能力扩展了也不再问。
 *
 * 这里不重做权限体系（那本来就在用），只补一件事：
 * **第一次遇到某一类危险动作时，告诉用户它意味什么。**
 *
 * ## 克制的边界（重要）
 *
 * - **每个类别只提示一次**，不是每次审批都弹
 * - **不增加确认步骤**——不多弹一个框、不要求输入文字。
 *   `desktop-agent-ui` 的铁律是「减少决策负荷」，加确认是反效果
 * - 只在**说明文字**上加一句后果，让用户在已有的审批卡片里看到
 *
 * ## 存储
 *
 * `localStorage`，键 `opencoxswain:approval-seen:<category>`。
 * 存不可用（隐私模式）时退化为"每次都提示"——安全侧，不是功能侧。
 */

/** 哪些类别值得提示。只挑**不可逆且影响外部**的。 */
const IMPACTFUL = new Set(['delete', 'push', 'publish']);

const STORAGE_PREFIX = 'opencoxswain:approval-seen:';

/** 每类的后果说明。一句话，说清"不可逆在哪"。 */
const IMPACT_NOTE: Record<string, string> = {
  delete: '删除后无法在软件内撤销。如果项目在 git 里，可以用 git 恢复。',
  push: '推送后内容会出现在远端，其他人可能已经看到。',
  publish: '发布后外部可访问，撤回需要额外操作。',
};

/** localStorage 可能不存在或被禁用。 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 这个类别的后果说明该不该显示。
 *
 * @returns 需要显示时返回说明文字，否则 null。
 */
export function firstTimeNote(category: string): string | null {
  if (!IMPACTFUL.has(category)) return null;
  const note = IMPACT_NOTE[category];
  if (!note) return null;

  const store = storage();
  // 存储不可用 → 每次都提示（宁可多说一次，不可漏说）
  if (!store) return note;

  try {
    if (store.getItem(STORAGE_PREFIX + category) === '1') return null;
    return note;
  } catch {
    return note;
  }
}

/**
 * 标记"已经提示过了"。
 *
 * **必须在用户做出决定之后调用**——在渲染时就标记的话，
 * 用户还没看到就被记成"看过"了。
 */
export function markNoteSeen(category: string): void {
  if (!IMPACTFUL.has(category)) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_PREFIX + category, '1');
  } catch {
    /* 写不进去就下次再提示 */
  }
}

/** 测试与调试用：清掉某个类别的记录。 */
export function resetSeen(category: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_PREFIX + category);
  } catch {
    /* 忽略 */
  }
}
