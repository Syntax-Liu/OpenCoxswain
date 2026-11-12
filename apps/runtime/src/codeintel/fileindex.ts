/**
 * @ 引用的文件索引。
 *
 * ## 为什么需要
 *
 * 用户说"改一下 @login.ts"，比说"改一下登录那个文件"明确得多。
 * 而且让 Assistant 自己 `search_files` 找文件，既慢又可能找错。
 *
 * @ 引用把"给哪个文件"这件事变成显式操作——用户明确知道给了它什么。
 *
 * ## 为什么不做成真正的文件树
 *
 * 文件多的项目（几百上千个）全量返回不现实，而且用户也不想要一个
 * 需要逐层点开的树。真正好用的是**输入即过滤**：
 * 打 `@log` 就出 `login.ts`、`logger.ts`、`docs/logging.md`。
 *
 * 所以这里只做两件事：列文件名、按模糊规则排序。
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** 单个文件条目。 */
export interface FileEntry {
  /** 相对项目根的路径，正斜杠。 */
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

/** 扫描上限：超过这个数量就不往下扫了，避免大项目卡住。 */
export const MAX_FILES = 5000;

/** 不扫的目录。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out',
  '.next', '.nuxt', 'coverage', '.cache', '.turbo', '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', 'env',
]);

/**
 * 文档类扩展名。
 *
 * 用户打 `@log` 时十有八九在找代码，不是找 `logging.md`。
 * 所以文档要**降权**——不是排除（用户可能真的想引用文档），
 * 只是让它排在代码之后。
 */
const DOC_EXT = new Set(['.md', '.txt', '.rst', '.adoc']);

/** 更愿意被引用的扩展名：代码优先于二进制。不是硬过滤，只影响排序。 */
const TEXT_HINT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go',
  '.java', '.kt', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.swift', '.vue', '.svelte', '.css', '.scss', '.html', '.json',
  '.yaml', '.yml', '.toml', '.sql', '.sh', '.ps1',
]);

/** 递归列出目录下的文件。 */
export async function listFiles(
  root: string,
  limit = MAX_FILES,
): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    if (depth > 14) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(root, full).replace(/\\/g, '/');
      files.push({ path: relative, name: entry.name, size: 0 });
    }
  }

  await walk(root, 0);
  return { files, truncated };
}

/**
 * 模糊匹配打分。
 *
 * 规则（分越高越靠前）：
 * - 文件名完全等于查询 → 最高
 * - 文件名以查询开头
 * - 文件名包含查询
 * - 路径包含查询
 * - 查询的字符按顺序散布在文件名里（`@lt` 能匹配 `login.ts`）
 *
 * 返回 null 表示不匹配。
 */
export function scoreFile(file: FileEntry, query: string): number | null {
  if (!query) return 0;

  const q = query.toLowerCase();
  const name = file.name.toLowerCase();
  const full = file.path.toLowerCase();

  if (name === q) return 1000;
  if (name === `${q}.ts` || name === `${q}.js` || name === `${q}.py`) return 950;
  if (name.startsWith(q)) return 900;
  if (name.includes(q)) return 800;
  if (full.includes(q)) return 600;

  // 子序列匹配：lt → l...t
  let i = 0;
  for (const ch of name) {
    if (ch === q[i]) i += 1;
    if (i === q.length) break;
  }
  if (i === q.length) return 300;

  return null;
}

/**
 * 按查询过滤并排序。
 *
 * 同一个分值下，**代码文件优先于其它**，浅层路径优先于深层。
 */
export function searchFiles(
  files: readonly FileEntry[],
  query: string,
  limit = 40,
): FileEntry[] {
  const scored: Array<{ file: FileEntry; score: number }> = [];

  for (const file of files) {
    const score = scoreFile(file, query);
    if (score === null) continue;

    // 权重：代码 > 其它 > 文档。
    //
    // 为什么文档要**大幅降权**：用户打 `@log` 时想要的是 login.ts，
    // 而 `docs/logging.md` 路径更浅反而会排上来——这不符合直觉。
    const ext = path.extname(file.name).toLowerCase();
    let bonus = Math.max(0, 20 - file.path.split('/').length * 3);
    // **先判文档**：.md 曾同时出现在两个集合里，导致降权分支永远走不到。
    if (DOC_EXT.has(ext)) bonus -= 200;
    else if (TEXT_HINT_EXT.has(ext)) bonus += 200;

    scored.push({ file, score: score + bonus });
  }

  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, limit).map((s) => s.file);
}

/**
 * 把一个被引用的文件转成注入上下文的内容。
 *
 * 太大就截断——引用一个 10MB 的日志会把上下文塞爆。
 */
export const MAX_REFERENCE_BYTES = 60_000;

export function renderReference(relativePath: string, content: string): string {
  const truncated = content.length > MAX_REFERENCE_BYTES;
  const body = truncated ? content.slice(0, MAX_REFERENCE_BYTES) : content;
  const note = truncated ? `\n…（已截断，原文件 ${content.length} 字符）` : '';
  return `【引用文件：${relativePath}】\n\`\`\`\n${body}${note}\n\`\`\``;
}

/** 从输入文本里抽出所有 @ 引用（返回相对路径）。 */
export function extractReferences(text: string): string[] {
  const out: string[] = [];
  // @ 后面直到空白；允许路径里有点和斜杠
  for (const m of text.matchAll(/@([\w./\\-]+)/g)) {
    const raw = m[1];
    if (raw) out.push(raw.replace(/\\/g, '/'));
  }
  return out;
}
