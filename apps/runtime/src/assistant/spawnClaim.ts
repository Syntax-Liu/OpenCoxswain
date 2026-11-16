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

  // 先说结论：**只要正文里出现 exe_ id，就一律交给调用方核对**。
  //
  // 原来是「id 前 40 字符里有派出类动词」才算，实测一直被绕过：
  //   - 「已实际调用工具，Agent id `exe_xxx`」  → "调用工具"不在动词表里
  //   - 「Agent id exe_xxx，状态 starting」      → 前面根本没有动词
  // 每次补一个动词，模型就换个说法。这个猫鼠游戏没有尽头。
  //
  // 所以不再做动词判定——**出现 id 就当声称**，由调用方用
  // 本轮真实创建的列表核对。对不上就是编的，怎么措辞都逃不掉。
  //
  // ## 唯一要排除的：明确否定的陈述
  //
  // 「数据库里没有 exe_abc 这条记录」「exe_xxx 不存在」这类是
  // **在陈述事实，不是在声称派活**，不该判错。
  const idRe = /(exe_[a-z0-9]{3,})/gi;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(text)) !== null) {
    const id = m[1]!;
    // 否定词**可能在 id 前面也可能在后面**：
    //   「数据库里没有 exe_abc」  → 前
    //   「exe_xyz 不存在」        → 后
    // 两边都要看，范围各 20 字符够用（再长容易误伤别处的否定）。
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    const after = text.slice(m.index + id.length, m.index + id.length + 20);
    const negRe = /(?:没有|不存在|查不到|找不到|未找到|无此)/;
    if (negRe.test(before) || negRe.test(after)) continue;
    ids.push(id);
  }

  // 去重（同一句里可能重复提到同一个 id）
  return [...new Set(ids)];
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
    // **承诺式**：「我会重新派一个」「我这就派」。
    //
    // 2026-11-16 用户实测（C1）：
    //
    // > Assistant 说会重新派一个 Agent 来完成，但也没有派
    //
    // 它说的是**将来时**，不是"已派出"，所以原来的规则全漏了。
    // 但对用户来说效果一样：被告知会有动作，实际没有。
    /(?:我|稍|等|马上|立刻|这就|在)\s*(?:会|就|再)?\s*(?:重新|再|来)?\s*(?:派|调)\s*(?:一个|个|出)?\s*(?:Agent|agent|执行者|任务)/i,
    // 「重新派一个」「再派一个」开头的承诺
    /(?:重新|再)\s*(?:派|跑)\s*(?:一个|个)\s*(?:Agent|agent)/i,
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

/**
 * 从历史里剔除"声称派活"的 assistant 消息。
 *
 * ## 为什么要在重试时清洗
 *
 * 根因不是"这一条说错了"，而是**历史里积了几十条样板**。
 * 模型看到前任写了「已派出 exe_xxx」，就照抄句式、不调工具
 * ——这是上下文里的范式模仿。
 *
 * 实测（2026-11-15 用户的库）：793 条 assistant 消息里 59 条含「已派出」，
 * 最严重的会话有 25 条。原来的重试只 pop 掉最后一条，
 * 剩下 24 条还摆在上下文里当范本。
 *
 * 更糟的是纠正语本身也含"已派出"三个字，等于又加一份样板。
 *
 * ## 只剔除 assistant 的
 *
 * 用户消息必须原样保留——用户说"派出去了吗"是有意义的追问，
 * 删掉会让对话失去上下文。
 *
 * ## 为什么不删更正消息
 *
 * 更正（"⚠ 更正：…不成立"）是真事实，删了会让模型以为之前真的派过。
 * 但它含"已派出"字样，所以这里**逐条判断**：
 * 声称派活且**不是**更正 → 剔除。
 */
export function sanitizeSpawnClaims<T extends { readonly role: string; readonly content: string | null }>(
  messages: readonly T[],
): T[] {
  return messages.filter((m) => {
    if (m.role !== 'assistant') return true;
    const text = m.content ?? '';

    // 更正消息保留：
    // 它是系统补的真相，删了模型会以为真的派过活。
    if (text.includes('不成立') || text.includes('实际没有创建')) return true;

    // 声称派活（带 id 或不带 id）→ 剔除
    if (claimsSpawn(text).length > 0) return false;
    if (claimsSpawnWithoutId(text)) return false;

    return true;
  });
}
