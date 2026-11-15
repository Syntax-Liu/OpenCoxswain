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
  //
  // 实测 2026-11-15：模型写成「我派出 Agent (exe_xxx) 进行统计」——
  // "派出"和 id 之间有 "Agent ("，原正则要求紧邻，漏了。
  // 现在把窗口拉到 40 字符，并补上「派出 / 派了 / 交给」等动词。
  const idRe = /(exe_[a-z0-9]{3,})/gi;
  let m: RegExpExecArray | null;
  const claimRe = /(?:已派出|派出了|已成功派出|已创建|派出|派了|交给|创建了)/;

  while ((m = idRe.exec(text)) !== null) {
    const id = m[1]!;
    const from = Math.max(0, m.index - 40);
    const before = text.slice(from, m.index);
    if (claimRe.test(before)) ids.push(id);
  }

  return ids;
}

/**
 * 文字里是否**不带 id** 地声称派了活。
 *
 * 实测（2026-11-15）：Assistant 回复
 *   「已派出，两个都在跑。」
 * 但本轮没有调用任何工具，running=0。
 *
 * 原检测只认「已派出 + exe_ id」，上面这句不含 id 就逃过了。
 * 用户被告知"在跑"，实际什么都没发生——比带错 id 更隐蔽。
 *
 * 这里覆盖常见的无 id 声称：
 *   - 已派出 / 派出了 / 派出了两个 / 已派出两个只读 Agent
 *   - 两个都在跑 / 正在跑 / 开始执行了
 */
export function claimsSpawnWithoutId(text: string): boolean {
  // 去掉 id 版本，避免和 claimsSpawn 重复计数
  const stripped = text.replace(/exe_[a-z0-9]{3,}/gi, '');

  const patterns = [
    // 「已派出」「派出了」后面紧跟数量/量词/Agent/句号
    /(?:已派出|已成功派出|派出了|已经派出|派了下去)\s*(?:[0-9一二两三四五六七八九十]+|个|只|名|Agent|执行者|，|,|。|\.)/i,
    // 「两个都在跑」「都在跑」「正在跑」
    /(?:[0-9一二两三四五六七八九十]+个)?\s*都?在跑/,
    // 「开始执行了」「正在执行」
    /(?:开始执行|已在执行|正在执行中)/,
  ];
  return patterns.some((p) => p.test(stripped));
}

/**
 * 判断一次回复是否需要纠正。
 *
 * 两种情况都算"谎报"：
 *   1. 说了具体 exe_ id 但实际没创建（phantomIds）
 *   2. 没给 id，但说了"已派出 / 都在跑"而本轮一次都没调 spawn
 *
 * @param text 本轮 Assistant 说的话
 * @param spawnedIds 本轮真正创建的 Agent id（来自 spawn 的返回值）
 */
export function auditSpawnClaims(
  text: string,
  spawnedIds: readonly string[],
): { wrong: boolean; phantomIds: string[]; vagueClaim: boolean } {
  const claimed = claimsSpawn(text);
  const real = new Set(spawnedIds);
  const phantomIds = claimed.filter((id) => !real.has(id));

  // 无 id 的笼统声称：只有在本轮**一个都没创建**时才算出错
  const vagueClaim = spawnedIds.length === 0 && claimsSpawnWithoutId(text);

  return {
    wrong: phantomIds.length > 0 || vagueClaim,
    phantomIds,
    vagueClaim,
  };
}

/** 生成给用户看的纠正话术。 */
export function correctionText(
  phantomIds: readonly string[],
  vagueClaim = false,
): string {
  if (phantomIds.length === 0 && !vagueClaim) return '';
  if (phantomIds.length > 0) {
    const list = phantomIds.join('、');
    return (
      `⚠ **更正**：上一条说的「已派出 ${list}」不成立——本轮实际没有创建任何 Agent。\n` +
      '文字描述不会派活，只有真的调用工具才会。需要我现在派吗？'
    );
  }
  return (
    '⚠ **更正**：上一条说「已派出」并不成立——本轮实际没有创建任何 Agent。\n' +
    '文字描述不会派活，只有真的调用工具才会。需要我现在派吗？'
  );
}
