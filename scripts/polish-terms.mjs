/**
 * 二次修正：术语替换后遗留的排版问题。
 *
 * 1. 中文与英文之间缺空格（"一群Agent" → "一群 Agent"）
 * 2. 表格/图示里残留的 D 代号
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = resolve(import.meta.dirname, '../docs');
const dry = process.argv.includes('--dry');

const FILES = [
  'ui-redesign-spec.md',
  'incident-spawn-claim.md',
  'next-steps.md',
  'open-source-plan.md',
  'ui-consistency-plan.md',
  'ui-design-spec.md',
  'project-status.md',
  'research.md',
];

/** 中英文之间补空格（只处理紧邻的中文字符与英文单词）。 */
function spaceAroundLatin(text) {
  return text
    // 中文 + 英文（大写开头，避免误伤代码）
    .replace(/([\u4e00-\u9fa5])(Agent|Assistant|Supervisor|User)\b/g, '$1 $2')
    // 英文 + 中文
    .replace(/\b(Agent|Assistant|Supervisor|User)([\u4e00-\u9fa5])/g, '$1 $2')
    // 数字 + Agent
    .replace(/(\d)(Agent)/g, '$1 $2');
}

/** 图示/表格里的 D 代号残留。 */
function fixLeftoverCodes(text) {
  return text
    .replace(/（D，一次任务一个）/g, '（一次任务一个）')
    .replace(/（D）/g, '（Agent）')
    .replace(/每个正在跑的 D 是/g, '每个正在跑的 Agent 是')
    .replace(/│   C: 已派/g, '│   Assistant: 已派')
    .replace(/(\d) 个Agent/g, '$1 个 Agent');
}

let changed = 0;
for (const rel of FILES) {
  const path = resolve(DOCS, rel);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  const before = text;
  text = fixLeftoverCodes(text);
  text = spaceAroundLatin(text);
  if (text !== before) {
    if (!dry) writeFileSync(path, text, 'utf8');
    changed += 1;
    console.log(`  ✓ ${rel}`);
  }
}
console.log(`\n修正 ${changed} 个文档`);
