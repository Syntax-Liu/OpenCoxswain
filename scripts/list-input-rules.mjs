/**
 * 列出输入类控件的每条规则，用于确定统一方案。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dirname, '../apps/web/src/styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** 收集所有选择器里含 input/textarea/select 的规则。 */
const rows = [];
for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/gm)) {
  const sel = m[2].trim().replace(/\s+/g, ' ');
  if (!/(input|textarea|select)/.test(sel)) continue;
  if (sel.startsWith('@')) continue;
  rows.push({ sel, body: m[3].trim().replace(/\s+/g, ' ') });
}

console.log(`含 input/textarea/select 的规则: ${rows.length}\n`);
for (const { sel, body } of rows) {
  const props = body
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^(background|border|border-color|border-radius|padding|height|font-size|outline|box-shadow|color)/.test(s));
  console.log(`▸ ${sel}`);
  if (props.length) console.log(`    ${props.join('; ')}`);
}

// 焦点态汇总
const focus = rows.filter((r) => r.sel.includes(':focus'));
console.log(`\n焦点态规则: ${focus.length}`);
for (const f of focus) console.log(`  ${f.sel} → ${f.body.slice(0, 120)}`);
