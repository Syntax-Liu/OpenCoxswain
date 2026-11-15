/**
 * 统一文档里的命名：按 docs/glossary.md 的正式名称改写。
 *
 * 规则：
 *   A/B/C/D 代号          → User / Supervisor / Assistant / Agent
 *   项目助理               → Assistant
 *   全局助理 / 总管         → Supervisor
 *   执行者 / 执行 Agent     → Agent
 *
 * 不动的：
 *   - docs/glossary.md 自身（它就是规则的来源，含"已废弃"说明）
 *   - 已封存的历史文档（trae-bao-plan.md 等，标注了封存，改它反而抹掉历史）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = resolve(import.meta.dirname, '../docs');
const dry = process.argv.includes('--dry');

/** 长串优先，避免部分匹配。 */
const RULES = [
  // --- 复合短语先处理 ---
  ['四个角色', '四个角色'],
  ['B 全局助理', 'Supervisor'],
  ['C 项目助理', 'Assistant'],
  ['用户直接对 C 说话，C 派 D 干活', '用户直接对 Assistant 说话，Assistant 派 Agent 干活'],
  ['用户 → C(一次性子代理)', '用户 → Assistant（一次性子代理）'],
  ['用户 → B → C', '用户 → Supervisor → Assistant'],
  ['用户 → C → D', '用户 → Assistant → Agent'],
  ['B → C → D', 'Supervisor → Assistant → Agent'],
  ['C 派 D', 'Assistant 派 Agent'],
  ['C 派活', 'Assistant 派活'],
  ['C 卡住', 'Assistant 卡住'],
  ['C 常驻', 'Assistant 常驻'],
  ['C 的', 'Assistant 的'],
  ['由 C 转达', '由 Assistant 转达'],
  ['经由 C', '经由 Assistant'],
  ['问 C', '问 Assistant'],
  ['找 C', '找 Assistant'],
  ['对 C 说', '对 Assistant 说'],
  ['进入 C', '进入 Assistant'],
  ['每个项目一个 C', '每个项目一个 Assistant'],
  ['一项目一 C', '一项目一 Assistant'],

  ['B 只做', 'Supervisor 只做'],
  ['B 的', 'Supervisor 的'],
  ['B 可以', 'Supervisor 可以'],
  ['B 不能', 'Supervisor 不能'],
  ['B 必须', 'Supervisor 必须'],
  ['B 需要', 'Supervisor 需要'],
  ['B 是', 'Supervisor 是'],
  ['找 B', '找 Supervisor'],
  ['问 B', '问 Supervisor'],

  ['D 执行', 'Agent 执行'],
  ['D 跑', 'Agent 跑'],
  ['D 的', 'Agent 的'],
  ['D 卡住', 'Agent 卡住'],
  ['派 D', '派 Agent'],
  ['一个 D', '一个 Agent'],
  ['新建 D', '新建 Agent'],
  ['开 D', '开 Agent'],
  ['每个 D', '每个 Agent'],
  ['两个 D', '两个 Agent'],
  ['多个 D', '多个 Agent'],
  ['D#1', 'Agent#1'],
  ['D#2', 'Agent#2'],

  // --- 旧中文名称 ---
  ['项目助理', 'Assistant'],
  ['全局助理', 'Supervisor'],
  ['执行 Agent', 'Agent'],
  ['执行者', 'Agent'],
  ['总管', 'Supervisor'],
];

/** 处理顺序：先改我自己写的文档，再处理与实现相关的。 */
const FILES = [
  'ui-redesign-spec.md',
  'incident-spawn-claim.md',
  'next-steps.md',
  'open-source-plan.md',
  'ui-consistency-plan.md',
  'ui-design-spec.md',
  'market-scan.md',
  'competitor-verdict.md',
  'project-status.md',
  'architecture.md',
  'research.md',
  'README.md',
];

let changedFiles = 0;
let totalHits = 0;

for (const rel of FILES) {
  const path = resolve(DOCS, rel);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  // glossary.md 规则源不动
  const before = text;
  let hits = 0;
  for (const [from, to] of RULES) {
    if (from === to) continue;
    if (text.includes(from)) {
      const n = text.split(from).length - 1;
      text = text.split(from).join(to);
      hits += n;
    }
  }
  if (text !== before) {
    if (!dry) writeFileSync(path, text, 'utf8');
    changedFiles += 1;
    totalHits += hits;
    console.log(`  ✓ ${rel}（${hits} 处）`);
  }
}

console.log(`\n改动 ${changedFiles} 个文档，共 ${totalHits} 处`);
