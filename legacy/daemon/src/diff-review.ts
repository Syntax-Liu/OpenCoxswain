import type { DiffFile, DiffFileStatus } from '@opencoxswain/shared';

export interface ParseDiffOptions {
  /** 单个文件最多展示的字符数，超出必须给出截断提示。 */
  maxFileChars?: number;
  /** 单次最多列出的文件数，超出计入 omitted。 */
  maxFiles?: number;
}

export interface ParsedDiff {
  files: DiffFile[];
  omitted: number;
}

const DEFAULT_MAX_FILE_CHARS = 64_000;
const DEFAULT_MAX_FILES = 200;

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripPrefix(value: string, prefix: string): string | null {
  const cleaned = unquote(value.trim());
  if (!cleaned || cleaned === '/dev/null') return null;
  return cleaned.startsWith(prefix) ? cleaned.slice(prefix.length) : cleaned;
}

function readLine(section: string, pattern: RegExp): string | null {
  for (const line of section.split('\n')) {
    const match = pattern.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}

function countLines(hunks: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of hunks.split('\n')) {
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function headerPaths(section: string): { oldPath: string | null; newPath: string | null } {
  const line = section.slice(0, section.indexOf('\n') >= 0 ? section.indexOf('\n') : undefined);
  const quoted = /^"a\/(.+)" "b\/(.+)"$/.exec(line);
  if (quoted) return { oldPath: quoted[1] ?? null, newPath: quoted[2] ?? null };
  const plain = /^a\/(.+) b\/(.+)$/.exec(line);
  if (plain) return { oldPath: plain[1] ?? null, newPath: plain[2] ?? null };
  return { oldPath: null, newPath: null };
}

function parseSection(section: string, maxFileChars: number): DiffFile | null {
  const fromHeaders = headerPaths(section);
  const oldLine = readLine(section, /^--- (.+)$/);
  const newLine = readLine(section, /^\+\+\+ (.+)$/);
  const oldPath = oldLine !== null ? stripPrefix(oldLine, 'a/') : fromHeaders.oldPath;
  const newPath = newLine !== null ? stripPrefix(newLine, 'b/') : fromHeaders.newPath;
  const renameFrom = readLine(section, /^rename from (.+)$/);
  const renameTo = readLine(section, /^rename to (.+)$/);
  const binary =
    section.includes('\nBinary files ') ||
    section.startsWith('Binary files ') ||
    section.includes('\nGIT binary patch');

  let status: DiffFileStatus = 'modified';
  if (renameFrom !== null && renameTo !== null) status = 'renamed';
  else if (section.includes('new file mode') || (oldPath === null && newPath !== null)) status = 'added';
  else if (section.includes('deleted file mode') || (newPath === null && oldPath !== null)) status = 'deleted';

  const path = unquote(renameTo ?? newPath ?? oldPath ?? '').trim();
  if (!path) return null;

  const hunkStart = section.search(/^@@ /m);
  const rawHunks = hunkStart >= 0 ? section.slice(hunkStart) : '';
  const counts = binary ? { additions: 0, deletions: 0 } : countLines(rawHunks);

  let hunks = binary ? '' : rawHunks;
  let truncated = false;
  let notice: string | undefined;
  if (binary) {
    notice = '二进制文件，不展示内容；请查看原始 diff 产物';
  } else if (hunks.length > maxFileChars) {
    const cut = hunks.lastIndexOf('\n', maxFileChars);
    hunks = hunks.slice(0, cut > 0 ? cut : maxFileChars);
    truncated = true;
    notice = `改动较大，仅展示前 ${hunks.length} 个字符；完整内容请查看原始 diff 产物`;
  }

  return {
    path,
    ...(status === 'renamed' && renameFrom ? { oldPath: unquote(renameFrom).trim() } : {}),
    status,
    binary,
    additions: counts.additions,
    deletions: counts.deletions,
    hunks,
    truncated,
    ...(notice ? { notice } : {}),
  };
}

/** 把 `git diff` 的整块 patch 拆成按文件的明细；只做解析，不改判定。 */
export function parseDiffPatch(patch: string, options: ParseDiffOptions = {}): ParsedDiff {
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const sections = patch.replace(/\r\n/g, '\n').split(/^diff --git /m).slice(1);
  const files: DiffFile[] = [];
  let omitted = 0;
  for (const section of sections) {
    if (files.length >= maxFiles) {
      omitted += 1;
      continue;
    }
    const parsed = parseSection(section, maxFileChars);
    if (parsed) files.push(parsed);
  }
  return { files, omitted };
}
