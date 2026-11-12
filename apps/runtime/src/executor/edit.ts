/**
 * 精确文本替换（`edit_file` 的核心）。
 *
 * ## 为什么需要这个工具
 *
 * 没有它，模型改一行代码就必须用 `write_file` 重写整个文件：
 * - **烧 token**：改一个字符要输出整份文件
 * - **容易错**：重写时模型可能"顺手"改动别的地方
 * - **大文件根本做不到**：超过输出上限就没法改
 *
 * ## 这个实现要处理的真实问题
 *
 * 1. **找不到**：模型记错了原文 → 明确报错，不要静默写入
 * 2. **找到多处**：默认拒绝，让模型给更长的上下文定位 → 避免改错地方
 * 3. **缩进不一致**：模型常把前导空格写少/写多 → 容忍，但要在结果里说明
 * 4. **换行符**：文件用 CRLF 而模型写 LF → 按文件自身的换行符写入
 */

export interface EditApplied {
  readonly ok: true;
  readonly content: string;
  /** 给模型看的说明（匹配方式、替换了多少处）。 */
  readonly summary: string;
}

export interface EditRejected {
  readonly ok: false;
  readonly error: string;
}

export type EditResult = EditApplied | EditRejected;

/** 匹配时忽略每行行首的空白差异（缩进）。 */
function normalizeIndent(line: string): string {
  return line.replace(/^[ \t]+/, '');
}

/** 文件用的是 CRLF 还是 LF？ */
function detectEol(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 在 haystack 里找 needle 的所有出现位置。
 *
 * 先精确找；找不到再退一步做"忽略行首缩进"的模糊找。
 * 这个退让很实用：模型经常在把代码从别处搬过来时丢掉缩进。
 */
function findAll(haystack: string, needle: string): { positions: number[]; exact: boolean } {
  const exact: number[] = [];
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    exact.push(at);
    from = at + needle.length;
  }
  if (exact.length > 0) return { positions: exact, exact: true };

  // 退一步：按行匹配，忽略行首空白
  const needleLines = needle.split('\n').map(normalizeIndent);
  const hayLines = haystack.split('\n');

  const starts: number[] = [];
  outer: for (let i = 0; i + needleLines.length <= hayLines.length; i += 1) {
    for (let j = 0; j < needleLines.length; j += 1) {
      // **注意是 hayLines[i + j]**：j 是 needle 内的行号，
      // 要映射到 haystack 里从 i 开始的对应行。
      // 写成 hayLines[j] 会让匹配永远停在文件开头，模糊匹配整体失效。
      if (normalizeIndent(hayLines[i + j]!).replace(/\r$/, '') !== needleLines[j]!.replace(/\r$/, '')) {
        continue outer;
      }
    }
    // 记录这一段的字符偏移
    let offset = 0;
    for (let k = 0; k < i; k += 1) offset += hayLines[k]!.length + 1;
    starts.push(offset);
  }
  return { positions: starts, exact: false };
}

/** 把某个偏移所在行的起始空白量出来。 */
function leadingIndentAt(content: string, position: number): string {
  const lineStart = content.lastIndexOf('\n', position - 1) + 1;
  const line = content.slice(lineStart, position);
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * 把替换文本的每一行套上原文的缩进。
 *
 * 只有当 old_text 的首行本来就有缩进时才需要——否则会把原本
 * 顶格的代码块往下推。
 */
function reindent(replacement: string, indent: string): string {
  if (!indent) return replacement;
  return replacement
    .split('\n')
    .map((line) => (line.trim() === '' ? line : indent + line))
    .join('\n');
}

/** 执行一次替换。 */
export function applyEdit(
  original: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): EditResult {
  if (oldText.length === 0) {
    return {
      ok: false,
      error: 'old_text 不能为空。要新建文件请用 write_file。',
    };
  }
  if (oldText === newText) {
    return { ok: false, error: 'old_text 与 new_text 相同，这次编辑不会改变任何内容。' };
  }

  const eol = detectEol(original);
  // 统一按 \n 处理，最后再还原文件自己的换行符
  const haystack = original.replace(/\r\n/g, '\n');
  const needle = oldText.replace(/\r\n/g, '\n');
  const replacement = newText.replace(/\r\n/g, '\n');

  const { positions, exact } = findAll(haystack, needle);

  if (positions.length === 0) {
    return {
      ok: false,
      error:
        '没找到 old_text。常见原因：\n' +
        '1. 原文有细微差异（空格、标点、换行）\n' +
        '2. 文件已经被改动过\n' +
        '建议：先用 read_file 重新读一遍，再复制确切内容。',
    };
  }

  if (positions.length > 1 && !replaceAll) {
    return {
      ok: false,
      error:
        `old_text 在文件里出现了 ${positions.length} 次，无法确定改哪一处。\n` +
        '请把 old_text 写得更长一些（多带几行上下文）来定位；\n' +
        '如果确实要全部替换，把 replace_all 设为 true。',
    };
  }

  // 从后往前替换，避免偏移错乱
  const targets = replaceAll ? positions : [positions[0]!];
  let out = haystack;
  for (let i = targets.length - 1; i >= 0; i -= 1) {
    const at = targets[i]!;
    // 模糊匹配时，把原文的缩进传给替换文本
    const body = exact ? replacement : reindent(replacement, leadingIndentAt(out, at));
    out = out.slice(0, at) + body + out.slice(at + needle.length);
  }

  // 还原文件自己的换行符
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');

  const parts: string[] = [];
  parts.push(replaceAll && targets.length > 1 ? `（替换 ${targets.length} 处）` : '');
  if (!exact) parts.push('（按缩进模糊匹配）');

  return { ok: true, content: out, summary: parts.filter(Boolean).join('') };
}
