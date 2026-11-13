/**
 * 检查 Assistant 有没有"预告派活"。
 *
 * ## 踩过的坑
 *
 * 实测（2026-11-13 21:41）：用户说"派一个只读 Agent 统计行数"，
 * Assistant 回复：
 *
 *     已派出 **exe_mwerrc1kx3y0j**（只读，writeScope: ["readonly"]）。
 *     它要交付：chapters/ 下每个 .tex 的文件名 + 行数 + 字节数……
 *
 * 但**它没有调用 spawn_executor**。数据库里查不到这个 id，
 * 最近一小时的 Agent 创建数为 0。
 *
 * 用户以为活派了，实际什么都没跑——这比报错更糟。
 *
 * ## 为什么提示词约束不够
 *
 * 提示词里已经有"不要凭记忆编"，但模型在长对话里仍会犯。
 * **文字描述不会创建任何东西**，所以要在运行时补一道硬检查。
 *
 * ## 做法
 *
 * 本轮跑完后检查：文字里说了"已派出 + 具体 id"，但本轮没调过 spawn_executor → 追加一条纠正。
 *
 * 纠正是**追加事实**，不是掩盖：告诉用户"刚才那句话不对，实际没派出"。
 */

/** 文字里是否声称派出了 Agent（带具体 id）。 */
export function claimsSpawn(text: string): string[] {
  const ids: string[] = [];

  // 先找**所有** exe_ id，再看它们附近有没有"已派出"这类声明。
  // 这样"已派出 exe_a 和 exe_b"里的两个都能抓到。
  const idRe = /(exe_[a-z0-9]{3,})/gi;
  let m: RegExpExecArray | null;

  while ((m = idRe.exec(text)) !== null) {
    const id = m[1]!;
    // 看这个 id 前面 30 个字符里有没有"已派出"类声明
    const from = Math.max(0, m.index - 30);
    const before = text.slice(from, m.index);
    if (/(?:已派出|派出了|已成功派出|已创建)/.test(before)) ids.push(id);
  }

  return ids;
}

/**
 * 判断一次回复是否需要纠正。
 *
 * @param text 本轮 Assistant 说的话
 * @param spawnedIds 本轮真正创建的 Agent id（来自 spawn 的返回值）
 */
export function auditSpawnClaims(
  text: string,
  spawnedIds: readonly string[],
): { wrong: boolean; phantomIds: string[] } {
  const claimed = claimsSpawn(text);
  if (claimed.length === 0) return { wrong: false, phantomIds: [] };

  const real = new Set(spawnedIds);
  const phantomIds = claimed.filter((id) => !real.has(id));

  return { wrong: phantomIds.length > 0, phantomIds };
}

/** 生成给用户看的纠正话术。 */
export function correctionText(phantomIds: readonly string[]): string {
  if (phantomIds.length === 0) return '';
  const list = phantomIds.join('、');
  return (
    `⚠ **更正**：上一条说的「已派出 ${list}」不成立——本轮实际没有创建任何 Agent。\n` +
    '文字描述不会派活，只有真的调用工具才会。需要我现在派吗？'
  );
}
