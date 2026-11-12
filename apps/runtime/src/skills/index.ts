/**
 * Skill：按需加载的工作知识。
 *
 * ## 和「扩展」的区别
 *
 * | | 扩展 (extensions) | 技能 (skills) |
 * --- | --- | --- |
 * | 给谁看 | **程序**（让运行时改行为） | **模型**（教它怎么做事） |
 * | 形态 | JS 代码 | Markdown 说明 |
 * | 何时生效 | 每次工具调用 | 模型主动调用 `use_skill` |
 *
 * ## 为什么需要
 *
 * 有些知识只对特定任务有用：「这个项目的测试怎么写」「发布流程是什么」。
 * 没有技能机制时，这些只能塞进系统提示词——**每条消息都在付费**。
 *
 * 技能的目录只注入「名称 + 一句话描述」（约 20 token），
 * 正文要模型主动调用才加载。一个 2000 字的技能，平时只花 20 token。
 *
 * ## SKILL.md 格式（对齐行业事实标准）
 *
 * ```markdown
 * ---
 * name: write-tests
 * description: 按项目约定写测试。当用户要求加测试时使用。
 * ---
 *
 * # 写测试
 *
 * 本项目用 vitest，测试文件放 src/test/*.test.ts……
 * ```
 *
 * 正文是给模型看的说明，怎么做都行——不需要是代码。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 一个技能的元信息（不含正文，正文按需读）。 */
export interface SkillSummary {
  /** kebab-case 标识，用于寻址。 */
  readonly name: string;
  /** 一句话描述——这是唯一常驻上下文的部分。 */
  readonly description: string;
  /** 什么时候该用它（可选，进一步帮助模型判断）。 */
  readonly whenToUse?: string;
  /** SKILL.md 的绝对路径。 */
  readonly path: string;
  /** 来自哪个根目录：project / user。 */
  readonly source: 'project' | 'user';
}

export interface SkillDefinition extends SkillSummary {
  /** Markdown 正文（已剥掉 frontmatter）。 */
  readonly content: string;
}

/** 名称必须是 kebab-case：便于当作工具参数稳定匹配。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 描述过长会挤占上下文，这里截断。 */
export const MAX_DESCRIPTION_LENGTH = 200;

export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly content: string;
}

/**
 * 解析 SKILL.md。
 *
 * 容错优先：frontmatter 缺字段时用目录名兜底，而不是丢弃整个技能——
 * 手写的文件格式出错是常事，直接不可用反而更烦人。
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkill | null {
  const text = raw.replace(/\r\n/g, '\n');

  // frontmatter 必须是文件开头的第一块 `---` ... `---`
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const body = match ? (match[2] ?? '') : text;
  const front = match ? (match[1] ?? '') : '';

  const fields = parseFrontmatter(front);
  const name = sanitizeName(fields.name ?? fallbackName);
  if (!name) return null;

  const description = truncate(
    fields.description ?? firstMeaningfulLine(body) ?? '',
    MAX_DESCRIPTION_LENGTH,
  );

  const result: ParsedSkill = {
    name,
    description,
    content: body.trim(),
    ...(fields['when-to-use'] ? { whenToUse: truncate(fields['when-to-use'], MAX_DESCRIPTION_LENGTH) } : {}),
  };
  return result;
}

/** 极简 frontmatter 解析：只支持 `key: value` 单行。 */
function parseFrontmatter(front: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();
    // 去掉可能的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** 没有 frontmatter 时，用正文第一个非标题行当描述。 */
function firstMeaningfulLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    return t;
  }
  return null;
}

/** 把不合法的名字转成 kebab-case；实在转不出来就返回 null。 */
function sanitizeName(raw: string): string | null {
  const kebab = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!kebab) return null;
  return SKILL_NAME_PATTERN.test(kebab) ? kebab : null;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * 扫描一个根目录下的技能。
 *
 * 支持两种布局：
 * - 目录包：`<root>/<name>/SKILL.md`
 * - 平铺文件：`<root>/<name>.md`
 *
 * 不递归：嵌套 discovery 会让人搞不清"到底加载了哪些"。
 */
export async function scanSkillRoot(root: string, source: 'project' | 'user'): Promise<SkillSummary[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: SkillSummary[] = [];

  for (const entry of entries) {
    const full = path.join(root, entry.name);

    if (entry.isDirectory()) {
      const file = path.join(full, 'SKILL.md');
      const summary = await readOne(file, entry.name, source);
      if (summary) found.push(summary);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const name = entry.name.slice(0, -3);
      const summary = await readOne(full, name, source);
      if (summary) found.push(summary);
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function readOne(
  file: string,
  fallbackName: string,
  source: 'project' | 'user',
): Promise<SkillSummary | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const parsed = parseSkillFile(await readFile(file, 'utf8'), fallbackName);
    if (!parsed) return null;
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {}),
      path: file,
      source,
    };
  } catch {
    // 读不了就跳过这个，不影响其它技能
    return null;
  }
}

/**
 * 合并多个根目录的技能。
 *
 * **项目级优先于用户级**：同一个名字，项目里的覆盖全局的——
 * 项目约定比个人习惯更贴近当前工作。
 */
export function mergeSkills(groups: readonly (readonly SkillSummary[])[]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();
  // 先放用户级，后面项目级会覆盖
  for (const group of [...groups].reverse()) {
    for (const skill of group) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 技能目录（注入给模型的那段文字）。只含名称和描述。 */
export function renderCatalog(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const when = s.whenToUse ? ` 适用：${s.whenToUse}` : '';
    return `- ${s.name}：${s.description}${when}`;
  });
  return ['## 可用技能', '', '需要时调用 use_skill 加载完整内容。', ...lines].join('\n');
}

/** 读取完整技能正文。 */
export async function loadSkill(skill: SkillSummary): Promise<SkillDefinition | null> {
  try {
    const parsed = parseSkillFile(await readFile(skill.path, 'utf8'), skill.name);
    if (!parsed) return null;
    return { ...skill, content: parsed.content };
  } catch {
    return null;
  }
}
