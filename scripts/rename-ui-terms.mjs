/**
 * 统一命名：把界面与注释里的旧称改成术语表（docs/glossary.md）规定的正式名称。
 *
 * 规则（来自 glossary.md）：
 *   User / Supervisor / Assistant / Agent —— 首字母大写，中文不翻译
 *   废弃：A/B/C/D 代号、项目助理、全局助理、执行者、总管
 *
 * 只改**字符串字面量与注释**，不动标识符（代码里的 executor 是历史名，按术语表保留）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../apps/web/src');
const dry = process.argv.includes('--dry');

/** 按顺序替换（长串在前，避免部分匹配）。 */
const RULES = [
  // 界面上用户能看到的文案
  ['还没有执行者。', '还没有 Agent。'],
  ['这个执行者已经不在列表里了。', '这个 Agent 已经不在列表里了。'],
  ['搜索项目、执行者或操作', '搜索项目、Agent 或操作'],
  ["group: '执行者'", "group: 'Agent'"],
  ['aria-label="执行者"', 'aria-label="Agent"'],
  ['<span className="panel-title">执行者</span>', '<span className="panel-title">Agent</span>'],
  ["role === 'user' ? '你' : '助理'", "role === 'user' ? '你' : 'Assistant'"],
  ["?? '执行者'", "?? 'Agent'"],
  ["'执行者 需要你确认'", "'Agent 需要你确认'"],

  // 注释里的旧称
  ['没有执行者时', '没有 Agent 时'],
  ['切项目时拉消息 + 执行者', '切项目时拉消息 + Agent'],
  ['面板只在有执行者或有待决策时出现', '面板只在有 Agent 或有待决策时出现'],
  ['打开执行者', '打开 Agent'],
  ['打开执行者详情页', '打开 Agent 详情页'],
  ['发给 C（项目助理）', '发给 Assistant'],
  ['一个执行者（D）一条跑道', '一个 Agent 一条跑道'],
  ['没有执行者时整个面板不渲染', '没有 Agent 时整个面板不渲染'],
  ['回答某个执行者的卡点：经由 C 转达', '回答某个 Agent 的卡点：经由 Assistant 转达'],
  ['面板是否该出现：有执行者，或有待决策', '面板是否该出现：有 Agent，或有待决策'],
  ['executorLabel = ', 'executorLabel = '],
];

const FILES = [
  'App.tsx',
  'components/CommandPalette.tsx',
  'components/DecisionCard.tsx',
  'components/RunnerLane.tsx',
  'components/RunnerPanel.tsx',
  'components/Transcript.tsx',
  'components/ApprovalPanel.tsx',
  'components/SettingsPanel.tsx',
  'components/TraceView.tsx',
  'components/ProjectSwitcher.tsx',
  'components/Composer.tsx',
];

let changedFiles = 0;
let totalHits = 0;

for (const rel of FILES) {
  const path = resolve(SRC, rel);
  let text = readFileSync(path, 'utf8');
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

console.log(`\n改动 ${changedFiles} 个文件，共 ${totalHits} 处`);

// 校验：界面文案里不该再有旧称
const BAD = ['执行者', '项目助理', '全局助理', '总管'];
let left = 0;
for (const rel of FILES) {
  const text = readFileSync(resolve(SRC, rel), 'utf8');
  for (const bad of BAD) {
    if (text.includes(bad)) {
      console.error(`  ✗ ${rel} 仍有「${bad}」`);
      left += 1;
    }
  }
}
console.log(left === 0 ? '界面代码无旧称残留' : `仍有 ${left} 处`);
process.exit(left === 0 ? 0 : 1);
