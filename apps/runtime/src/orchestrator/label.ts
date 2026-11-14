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
  // **带 g 标志的正则会记住 lastIndex**，连续调用会在中途开始匹配，
  // 造成"同样输入、不同结果"的诡异行为。每次调用前重置。
  FILE_PATTERN.lastIndex = 0;
  const byFile = FILE_PATTERN.test(label);
  FILE_PATTERN.lastIndex = 0;
  return TOOL_PATTERN.test(label) || byFile;
}

/**
 * 判断清理结果是否**成句**。
 *
 * ## 判据的演进
 *
 * 第一版：至少 4 个字，且不像方位词。
 * 结果实测 **36 条里 34 条都回退了**——太严。
 *
 * 打印出清理后的中间形态才发现，大多数其实是可读的：
 *
 *     "把 notes.md 整个覆盖为指定两行内容"  →  "把整个覆盖为指定两行内容"   ✓ 能懂
 *     "统计 chapters 下每个 .tex 的行数"     →  "统计chapters下每个文件的行数"  ✓ 能懂
 *     "分析 README/main.tex 结构"            →  "分析结构（任务5，只读）"        ✓ 能懂
 *
 * 真正不能用的只有两种：
 *
 *     "把 target.txt 的内容改成「…」"  →  "把的内容改成"     ✗ 缺宾语
 *     "write_file 写 race-a.txt 为「…」"  →  "写为"          ✗ 只剩动词
 *
 * 所以判据改成：**长度 ≥ 4**（"写为" 2 个字挡掉），
 * 且**不是以"把/的/了"开头接虚词**（"把的内容"挡掉）。
 */
function isUsable(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;

  // 只剩"方位词 + 动词"——去掉文件名后主语丢了。
  // 例："用 write_file 把根目录 xxx.txt 写成「A」" → "根目录写成"
  if (/^(?:根目录|目录|文件|内容|这里|那里)(?:写成|改为|改成|写为|覆盖|替换|删除|移动)/.test(t)) {
    return false;
  }

  // "把的内容改成""的字节内容" —— 缺宾语
  if (/^(?:把|的|了|和|与|对)(?:的|了)?(?:内容|字节|文件)?/.test(t) && t.length < 8) return false;

  return /[\u4e00-\u9fa5]{2,}/.test(t);
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

  // 收拾残句：清掉因删除产生的多余空格。
  //
  // 中文之间不留空格（"统计 chapters 目录" → "统计chapters目录"读起来更紧），
  // 但**中英文之间留一个**，否则 "分析LaTeX结构" 会粘连。
  out = out
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '')
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
