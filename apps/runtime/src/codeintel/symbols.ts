/**
 * 代码导航：在不引入语言服务器的前提下，做到"够用"的符号理解。
 *
 * ## 为什么不做真正的 LSP
 *
 * 真正的 LSP 要：
 * - 启动语言服务器进程（typescript-language-server、pylsp……）
 * - 实现完整 JSON-RPC + LSP 协议栈（initialize、didOpen、definition、
 *   references、documentSymbol……）
 * - 处理文件同步、增量更新、位置编码（UTF-16 vs UTF-8）
 *
 * 工作量很大，而且 **每种语言要配一个服务器**（用户机器上未必有）。
 *
 * 而我们真正要解决的具体问题是：
 * - "这个函数在哪定义的"
 * - "谁调用了它"
 * - "这个文件里有哪些函数/类"
 *
 * 这三个用**结构化文本搜索 + 轻量语法识别**就能达到八成效果，
 * 且**零依赖、零配置、任何语言都能用**。剩下的两成（类型推断、
 * 跨模块重导出）等真的有痛点再说。
 *
 * ## 诚实说明局限
 *
 * 这里的"定义"是**词法层面**的判断（看 `function foo`、`const foo =`
 * 这类模式），不是语义分析。所以：
 * - ✅ 找函数/类/变量的声明位置 —— 可靠
 * - ✅ 找调用点 —— 可靠（按标识符边界匹配）
 * - ❌ 区分同名不同作用域的符号 —— 做不到
 * - ❌ 跟踪跨文件重导出 —— 做不到
 *
 * 界面上会如实说明这一点，不假装是完整的语义分析。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/** 一个符号的定义位置。 */
export interface SymbolLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** 该行的原文（截断），便于直接判断。 */
  readonly preview: string;
  readonly kind: SymbolKind;
}

export type SymbolKind = 'function' | 'class' | 'interface' | 'variable' | 'import' | 'unknown';

/** 各语言的常见定义写法。
 *
 * **顺序很重要**：越具体的模式要排在越前面。
 * 比如 Go 的 `type Point struct` 必须排在 TS 的通用 `type Point = ...` 之前，
 * 否则会被误判成"类型别名"。
 */
const DEFINITION_PATTERNS: ReadonlyArray<{
  readonly kind: SymbolKind;
  readonly pattern: RegExp;
}> = [
  // ---- 先放最具体的写法 ----

  // Go：type X struct/interface（必须早于 TS 的通用 type）
  { kind: 'class', pattern: /^\s*type\s+NAME\s+(?:struct|interface)\b/ },
  // Rust：struct/enum/trait
  { kind: 'class', pattern: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+NAME\b/ },
  // Rust：fn
  { kind: 'function', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+NAME\b/ },
  // Python
  { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+NAME\s*\(/ },
  { kind: 'class', pattern: /^\s*class\s+NAME\b/ },

  // ---- TypeScript / JavaScript ----
  { kind: 'function', pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+NAME\b/ },
  { kind: 'function', pattern: /^\s*(?:export\s+)?const\s+NAME\s*=\s*(?:async\s*)?(?:\(|function\b)/ },
  { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+NAME\b/ },
  { kind: 'interface', pattern: /^\s*(?:export\s+)?(?:interface|type)\s+NAME\b/ },
  { kind: 'variable', pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+NAME\b/ },
  // 方法定义：`  name(...) {`
  { kind: 'function', pattern: /^\s+(?:async\s+)?NAME\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/ },

  // ---- 兜底 ----
  { kind: 'function', pattern: /^\s*func\s+(?:\([^)]*\)\s*)?NAME\b/ },
];

const KIND_LABEL: Record<SymbolKind, string> = {
  function: '函数',
  class: '类/结构',
  interface: '接口/类型',
  variable: '变量',
  import: '导入',
  unknown: '符号',
};

/** 要跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  'coverage',
  '.cache',
]);

/** 只看这些扩展名的文件（避免扫二进制）。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.kt', '.rb', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift',
  '.vue', '.svelte', '.css', '.scss', '.html', '.json', '.md',
]);

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

/** 把标识符安全地嵌进正则。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 收集目录下的文本文件（相对路径）。 */
async function collectFiles(root: string, limit: number): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && isTextFile(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return out;
}

/** 判断某一行是不是给 `name` 的定义。 */
export function matchDefinition(line: string, name: string): SymbolKind | null {
  const escaped = escapeRegExp(name);
  for (const { kind, pattern } of DEFINITION_PATTERNS) {
    // 把模式里的 NAME 换成实际标识符，并加上词边界
    const source = pattern.source.replace(/NAME/g, `(?:${escaped})`);
    if (new RegExp(source).test(line)) return kind;
  }
  return null;
}

/**
 * 这一行是不是「块内局部声明」——不该算作文件的符号。
 *
 * **不能用缩进判断**：函数体内的声明可能和顶层一样缩进两格，
 * 靠缩进必然误判。改用**大括号深度**：只有深度为 0 的声明才算文件级。
 *
 * 这也是为什么它需要在扫描时按行累加深度，而不是单独看一行。
 */
function isBlockLocal(trimmed: string): boolean {
  return /^(?:for|while|if|switch|catch|else)\b/.test(trimmed);
}

/**
 * 估算一行结束时的大括号净变化。
 *
 * 粗糙但够用：忽略字符串和注释里的括号（那些在真实代码里占比很低，
 * 而且误算只会让判断偏保守——多过滤掉几个符号，不会把局部的当成全局）。
 */
function braceDelta(line: string): number {
  // 去掉行注释和字符串字面量，避免里面的括号干扰计数
  const cleaned = line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  let delta = 0;
  for (const ch of cleaned) {
    if (ch === '{') delta += 1;
    else if (ch === '}') delta -= 1;
  }
  return delta;
}

/** 统计标识符在文本里出现的次数（按词边界）。 */
export function countOccurrences(text: string, name: string): number {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
  return (text.match(re) ?? []).length;
}

export interface FindSymbolResult {
  readonly definitions: readonly SymbolLocation[];
  readonly references: readonly SymbolLocation[];
  /** 扫描了多少文件。 */
  readonly scannedFiles: number;
  /** 是否因为达到上限而截断。 */
  readonly truncated: boolean;
}

/**
 * 找一个符号的定义与引用。
 *
 * 两趟扫描：
 * 1. 第一趟找定义（匹配语言特定的声明模式）
 * 2. 第二趟找引用（按标识符边界匹配，排除定义行本身）
 */
export async function findSymbol(
  root: string,
  name: string,
  options: { readonly maxFiles?: number; readonly maxResults?: number } = {},
): Promise<FindSymbolResult> {
  const maxFiles = options.maxFiles ?? 3000;
  const maxResults = options.maxResults ?? 60;

  const files = await collectFiles(root, maxFiles);
  const definitions: SymbolLocation[] = [];
  const references: SymbolLocation[] = [];
  let truncated = false;

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(name)) continue;

    const relative = path.relative(root, file).replace(/\\/g, '/');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (!line.includes(name)) continue;

      const lineNo = i + 1;
      const col = line.indexOf(name) + 1;
      const preview = line.trim().slice(0, 120);

      const defKind = matchDefinition(line, name);
      if (defKind) {
        definitions.push({ file: relative, line: lineNo, column: col, preview, kind: defKind });
        continue;
      }

      // 引用：按词边界判断，避免误命中 fooBar 里的 foo
      if (countOccurrences(line, name) > 0) {
        references.push({ file: relative, line: lineNo, column: col, preview, kind: 'unknown' });
      }

      if (definitions.length + references.length >= maxResults * 2) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return {
    definitions,
    references: references.slice(0, maxResults),
    scannedFiles: files.length,
    truncated,
  };
}

/** 列出一个文件里的所有符号定义。 */
export async function listSymbols(filePath: string): Promise<SymbolLocation[]> {
  const text = await readFile(filePath, 'utf8');
  const out: SymbolLocation[] = [];
  const lines = text.split('\n');

  // 大括号深度：只有深度 0 的声明才是文件级符号。
  // 用它而不是缩进——函数体内的声明可能和顶层一样缩进。
  let depth = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // 先记录「这一行开始时」的深度，再更新
    const startDepth = depth;
    depth += braceDelta(line);

    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }
    if (startDepth > 0) continue; // 在块内部：是局部实现，不是文件级符号
    if (isBlockLocal(trimmed)) continue;

    // 从行里抽出候选标识符，逐个试定义模式
    const candidates = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    for (const candidate of candidates) {
      const kind = matchDefinition(line, candidate);
      if (kind) {
        out.push({
          file: filePath,
          line: i + 1,
          column: line.indexOf(candidate) + 1,
          preview: trimmed.slice(0, 120),
          kind,
        });
        break; // 一行只记第一个定义
      }
    }
  }

  return out;
}

/** 把结果渲染成模型能读的文本。 */
export function renderSymbolResult(name: string, result: FindSymbolResult): string {
  const lines: string[] = [];

  if (result.definitions.length === 0 && result.references.length === 0) {
    return (
      `没找到符号 ${name}。\n` +
      `（扫描了 ${result.scannedFiles} 个文件。` +
      '这可能是因为它来自第三方包，或者名称拼写不同。）'
    );
  }

  if (result.definitions.length > 0) {
    lines.push(`## ${name} 的定义（${result.definitions.length} 处）`);
    for (const d of result.definitions) {
      lines.push(`- ${d.file}:${d.line}:${d.column}  [${KIND_LABEL[d.kind]}]  ${d.preview}`);
    }
  } else {
    lines.push(`## ${name} 的定义`);
    lines.push('（没找到定义——它可能来自依赖包，或在当前扫描范围内未出现）');
  }

  if (result.references.length > 0) {
    lines.push('');
    lines.push(`## 引用（${result.references.length} 处）`);
    for (const r of result.references) {
      lines.push(`- ${r.file}:${r.line}:${r.column}  ${r.preview}`);
    }
  }

  if (result.truncated) {
    lines.push('');
    lines.push('（结果已截断，把 scope 收窄到具体目录能看得更全。）');
  }

  lines.push('');
  lines.push(
    '说明：这是**词法层面**的匹配，不是完整语义分析。' +
      '同名但不同作用域的符号会被混在一起；跨文件重导出可能找不到。',
  );

  return lines.join('\n');
}
