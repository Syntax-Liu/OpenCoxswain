/**
 * 批量清理角色代号（全文档）。
 *
 * ## 为什么不能无脑替换
 *
 * `A` / `B` / `C` / `D` 在文档里有四种完全不同的用途：
 *   1. **角色代号**（要改）："C 常驻"、"D 派发"、"B Supervisor"
 *   2. **决策编号**（保留）："D1"、"D2"、"D11"
 *   3. **方案选项**（保留）："A. 上下文压缩"、"B. 工具调用加硬约束"
 *   4. **泛指/路径**（保留）："改了 A 坏了 B"、"D:/work"
 *
 * 判断依据：**代号后面紧跟动词或角色词**（常驻、派发、派、收、收到、看不到、的…）
 * 才算角色。这样能避开编号与泛指。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = resolve(import.meta.dirname, '../docs');
const dry = process.argv.includes('--dry');

/** 角色名映射。 */
const NAME = { A: 'User', B: 'Supervisor', C: 'Assistant', D: 'Agent' };

/**
 * 这些词紧跟代号时，几乎一定是角色语境。
 * 例如 "C 常驻"、"D 派发"、"B 指路"。
 */
const ROLE_FOLLOWERS = [
  '常驻', '派发', '派活', '派', '收', '收到', '看不到', '能', '不', '现在', '还是',
  '会', '要', '的', '与', '和', '在', '是', '已', '不', '只', '卡', '写', '完成',
  '会话', '判断', '决定', '汇报', '指路', 'Supervisor', 'Assistant', 'Agent', 'User',
];

/** 保留上下文（命中这些就不动）。 */
const KEEP_PATTERNS = [
  /A\/B\/C\/D/,
  /改了\s*A\s*坏了\s*B/,
  /D:\//,
  /^[A-D]\.\s/, // 行首选项
  /\|\s*[A-D]\s*\|/, // 表格里单独一列（多为枚举）
];

/** 每行做替换。 */
function convertLine(line) {
  if (KEEP_PATTERNS.some((re) => re.test(line))) return line;

  let out = line;
  // 逐个别名替换，但只在"代号 + 角色词"时替换
  for (const [code, name] of Object.entries(NAME)) {
    // 排除 D1/D2 这类决策编号：要求代号后面不是数字
    const re = new RegExp(
      `(?<![A-Za-z0-9_/])${code}(?![A-Za-z0-9_])`,
      'g',
    );
    out = out.replace(re, (_m, offset) => {
      const after = out.slice(offset + 1, offset + 12);
      // 后面紧跟数字 → 决策编号，保留
      if (/^\d/.test(after)) return code;
      // 后面是角色词 → 替换
      if (ROLE_FOLLOWERS.some((w) => after.startsWith(w))) return name;
      // 后面是空格 + 角色词
      const trimmed = after.replace(/^\s+/, '');
      if (ROLE_FOLLOWERS.some((w) => trimmed.startsWith(w))) return name;
      return code;
    });
  }
  return out;
}

const files = (await import('node:fs')).readdirSync(DOCS).filter((f) => f.endsWith('.md'));
let changedFiles = 0;
let totalLines = 0;

for (const f of files) {
  const path = resolve(DOCS, f);
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let fileChanged = 0;
  const next = lines.map((line) => {
    const conv = convertLine(line);
    if (conv !== line) fileChanged += 1;
    return conv;
  });
  if (fileChanged > 0) {
    if (!dry) writeFileSync(path, next.join('\n'), 'utf8');
    changedFiles += 1;
    totalLines += fileChanged;
    console.log(`  ✓ ${f}（${fileChanged} 行）`);
  }
}

console.log(`\n改动 ${changedFiles} 个文件，共 ${totalLines} 行`);

