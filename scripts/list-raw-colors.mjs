/**
 * 列出组件区（原始色板之外）的全部裸色值，按用途分组。
 *
 * 这些是 VS Code 时代的遗留配色，写死的十六进制不会跟随主题切换。
 * 处理前必须先看清每一处是"结构色"（能换令牌）还是"功能色"（语义明确）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '../apps/web/src/styles.css');
const css = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// 原始色板区间：:root 内 --c-* 的定义，属于合法色值
const rootEnd = css.indexOf('}', css.indexOf(':root'));
const componentsStart = rootEnd;

/** 找出每个裸色值所在的规则与其属性。 */
const rows = [];
let depth = 0;
let selStart = 0;
let currentSel = '';

for (let i = 0; i < css.length; i += 1) {
  const ch = css[i];
  if (ch === '{') {
    if (depth === 0) {
      currentSel = css.slice(selStart, i).replace(/^\s+/, '').replace(/\s+/g, ' ').trim();
    }
    depth += 1;
  } else if (ch === '}') {
    depth -= 1;
    if (depth === 0) selStart = i + 1;
  } else if (depth === 1 && i > componentsStart) {
    // 在规则体内，向前看是否是一个色值
    if (ch === '#' || (ch === 'r' && css.startsWith('rgb', i))) {
      const m = /^#[0-9a-fA-F]{3,8}\b/.exec(css.slice(i)) ?? /^rgba?\([^)]*\)/.exec(css.slice(i));
      if (m) {
        const propStart = css.lastIndexOf(';', i) + 1;
        const propText = css.slice(propStart, i).trim();
        const propName = /^([a-z-]+)\s*:/.exec(propText)?.[1] ?? '?';
        rows.push({ sel: currentSel, prop: propName, value: m[0], index: i });
      }
    }
  }
}

// 去重（同一位置的 `#` 与后续字符只记一次）
const seen = new Set();
const unique = rows.filter((r) => {
  const key = `${r.index}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

console.log(`组件区裸色值共: ${unique.length}\n`);

// 按值分组
const byValue = new Map();
for (const r of unique) {
  if (!byValue.has(r.value)) byValue.set(r.value, []);
  byValue.get(r.value).push(r);
}

const sorted = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [value, uses] of sorted) {
  const props = [...new Set(uses.map((u) => u.prop))].join(',');
  console.log(`${value.padEnd(26)} ×${String(uses.length).padStart(2)}  [${props}]`);
  for (const u of uses.slice(0, 3)) console.log(`      ${u.sel.slice(0, 60)}`);
  if (uses.length > 3) console.log(`      …还有 ${uses.length - 3} 处`);
}
