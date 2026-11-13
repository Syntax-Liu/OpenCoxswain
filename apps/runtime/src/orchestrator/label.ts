/**
 * 侧栏里 Agent 标签的显示处理。
 *
 * ## 问题
 *
 * 侧栏直接显示 Agent 的 `label`，但那些 label 常常是**任务原话照搬**，
 * 带着工具名和文件名：
 *
 *     用 write_file 把 undo-test.txt 改为「改过了」
 *     统计根目录 .txt 数量并写入 dep-a.txt
 *
 * 实测历史数据里 **25 条有 14 条** 是这样。
 * 用户关心"它在干什么"，不关心"动了哪个文件"。
 *
 * ## 走过的弯路：先试过"删字符串"
 *
 * 第一版想法是正则删掉工具名和文件名。结果：
 *
 *     "用 write_file 把根目录 conflict-test.txt 写成「A」"  →  "根目录"
 *     "统计根目录 .txt 数量并写入 dep-a.txt"                →  "统计根目录 数量并写入"
 *
 * **清出来的是残句**，比原文更难懂。机器删字符串做不出好标签。
 *
 * ## 现在的做法：识别 + 标注，不硬删
 *
 * 1. 能识别出实现细节 → 把它**收进 tooltip**，主行显示清理后的短句
 * 2. 清理后不成句 → **保留原文**
 *
 * 关键原则：**宁可显示得啰嗦，也不要把意思删没了**。
 */

/** 已知工具名（用于识别）。 */
const TOOL_WORDS =
  'write_file|edit_file|read_file|list_dir|search_files|run_command|find_symbol|list_symbols|use_skill';
const TOOL_PATTERN = new RegExp(`\\b(?:${TOOL_WORDS})\\b`, 'i');

/** 文件路径/扩展名（含前面分隔符）。 */
const FILE_PATTERN =
  /(^|[\s，、])(?:[\w\u4e00-\u9fa5./\\-]*\.(?:txt|ts|tsx|js|jsx|json|md|py|rs|toml|yaml|yml|css|html|tex|pdf|log|gitignore))\b/gi;

/** 是否含实现细节。 */
export function hasImplementationDetail(label: string): boolean {
  return TOOL_PATTERN.test(label) || FILE_PATTERN.test(label);
}

/**
 * 判断清理结果是否**成句**。
 *
 * ## 为什么标准是严的
 *
 * 试过放宽到"2 个中文字就算成句"，结果：
 *
 *     "用 write_file 把 xxx.txt 写成「A」"  →  "根目录写成"
 *     "Agent2：write_file 写 xxx.txt 为「B」"  →  "写为内容"
 *
 * 这种比原文**更难懂**——用户看到"写为内容"完全不知道在写什么。
 *
 * 所以标准保持严：清完不成句就**保留原文**，让提示词去解决新增的数据。
 * 历史数据里清不掉的几条，显示原文比显示残句好。
 */
function isUsable(text: string): boolean {
  const t = text.trim();
  // 至少 4 个字，且能看出"做了什么 + 对什么"
  if (t.length < 4) return false;
  // 纯动词/方位词不算
  if (/^(?:写成|改为|改成|写为|根目录|目录|文件|内容|这里|那里)/.test(t) && t.length < 6) {
    return false;
  }
  return /[\u4e00-\u9fa5]{3,}/.test(t);
}

/**
 * 生成侧栏用的显示文本。
 *
 * 返回 `{ text, wasCleaned }`——调用方可以据此决定要不要把原文放进 tooltip。
 */
export function displayLabel(label: string): { text: string; wasCleaned: boolean } {
  const original = label.trim();
  if (!original) return { text: '', wasCleaned: false };
  if (!hasImplementationDetail(original)) return { text: original, wasCleaned: false };

  // 去掉 Agent 编号前缀（侧栏里每个都是 Agent，不用标）
  let out = original.replace(/^Agent\s*\d*\s*[：:]\s*/i, '');

  // 去掉工具名。**连同前后紧挨的"用/把/给/将"一起抹**，
  // 否则会留下"用  把根目录..."这种带空隙的残句。
  out = out.replace(
    new RegExp(
      `(?:用|使用|调用|通过)?\\s*\\\`?(?:${TOOL_WORDS})\\\`?\\s*(?:把|给|将)?`,
      'gi',
    ),
    ' ',
  );

  // 去掉文件路径（含前面那个分隔空格）
  FILE_PATTERN.lastIndex = 0;
  out = out.replace(FILE_PATTERN, '$1');

  // 去掉引号里被改成的目标内容（那是细节，不是意图）
  out = out.replace(/「[^」]*」/g, ' ');
  out = out.replace(/"[^"]*"/g, ' ');

  // 收拾残句：清掉因删除产生的多余空格
  out = out
    .replace(/\s+/g, '')
    .replace(/^[\s，,：:、的]+|[\s，,：:、的]+$/g, '');

  if (!isUsable(out)) {
    // **清理后不成句 → 保留原文**。宁可啰嗦，不要把意思删掉。
    return { text: original, wasCleaned: false };
  }
  return { text: out, wasCleaned: true };
}

/** 只要文本的简版。 */
export function cleanLabel(label: string): string {
  return displayLabel(label).text;
}
