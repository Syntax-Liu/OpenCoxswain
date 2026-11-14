/**
 * 统计 styles.css 里的按钮/控件类规则，用于确认迁移进度。
 * 单独成脚本，避免 shell 转义破坏正则。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../apps/web/src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 收集所有以 .xxx 开头的选择器（单选择器规则）。 */
const selectors = new Map();
for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/gm)) {
  const body = m[2].trim();
  if (!body || body.startsWith('@')) continue;
  for (const one of body.split(',')) {
    const sel = one.trim();
    if (sel.startsWith('.')) {
      selectors.set(sel, (selectors.get(sel) ?? 0) + 1);
    }
  }
}

const controlLike = [...selectors.keys()].filter((s) =>
  /(^|\.)([a-z-]*(btn|chip|pill|tab|toggle))([ .:]|$)/.test(s),
);

// 只统计"基类"（去掉 :hover / .active 等状态后缀）
const bases = new Set();
for (const s of controlLike) {
  const m = /^\.([a-z0-9-]+)/.exec(s);
  if (m) bases.add(m[1]);
}

const migrated = [
  'btn', 'icon-btn', 'theme-btn', 'font-scale-btn', 'trace-filter-btn',
  'msg-action-btn', 'composer-chip', 'perm-picker-btn', 'project-picker-btn',
  'attach-btn', 'back-btn',
];
const remaining = [...bases].filter((b) => !b.startsWith('btn')).sort();

console.log(`规则总数（含状态）: ${controlLike.length}`);
console.log(`基类总数:          ${bases.size}`);
console.log(`\n已迁移到 .btn 但仍残留 CSS 的:`);
const leftover = migrated.filter((m) => m !== 'btn' && bases.has(m));
console.log(leftover.length ? leftover.map((x) => '  ' + x).join('\n') : '  （无）');

console.log(`\n尚未迁移的控件基类（${remaining.length}）:`);
console.log(remaining.map((x) => '  .' + x).join('\n'));
