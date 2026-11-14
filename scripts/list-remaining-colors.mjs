/**
 * 列出组件区剩余的裸色值及其选择器/属性，用于逐个判断怎么处理。
 * 排除 :root 与 :root[data-theme] 内的定义（那是合法色板）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../apps/web/src/styles.css'), 'utf8');
const nc = css.replace(/\/\*[\s\S]*?\*\//g, '');

const rows = [];
let depth = 0;
let selStart = 0;
let currentSel = '';
let inThemeBlock = false;

for (let i = 0; i < nc.length; i += 1) {
  const ch = nc[i];
  if (ch === '{') {
    if (depth === 0) {
      currentSel = nc.slice(selStart, i).replace(/^\s+/, '').replace(/\s+/g, ' ').trim();
      inThemeBlock = /^:root/.test(currentSel);
    }
    depth += 1;
  } else if (ch === '}') {
    depth -= 1;
    if (depth === 0) selStart = i + 1;
  } else if (depth >= 1 && !inThemeBlock) {
    let m = null;
    if (ch === '#') m = /^#[0-9a-fA-F]{3,8}\b/.exec(nc.slice(i));
    else if (ch === 'r' && nc.startsWith('rgb', i)) m = /^rgba?\([^)]*\)/.exec(nc.slice(i));
    if (m) {
      const propStart = nc.lastIndexOf(';', i) + 1;
      const prop = /^([a-z-]+)\s*:/.exec(nc.slice(propStart, i).trim())?.[1] ?? '?';
      rows.push({ sel: currentSel, prop, value: m[0] });
    }
  }
}

const byValue = new Map();
for (const r of rows) {
  if (!byValue.has(r.value)) byValue.set(r.value, []);
  byValue.get(r.value).push(r);
}

console.log(`组件区裸色值: ${rows.length} 处，去重后 ${byValue.size} 种\n`);
for (const [value, uses] of [...byValue.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${value.padEnd(22)} ×${uses.length}  ${uses.map((u) => `${u.sel}(${u.prop})`).slice(0, 2).join(' , ')}`);
}
