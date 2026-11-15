/**
 * 诊断 CSS 注释结构问题。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const p = resolve(import.meta.dirname, '../apps/web/src/design/app.css');
const css = readFileSync(p, 'utf8');
const head = css.slice(0, css.indexOf(':root'));

const terminators = [...head.matchAll(/\*\//g)];
console.log(`文件头注释区里 "*/" 出现 ${terminators.length} 次`);

for (const m of terminators) {
  const start = Math.max(0, m.index - 50);
  const ctx = head.slice(start, m.index + 3).replace(/\n/g, ' | ');
  console.log(`  位置 ${m.index}: …${ctx}`);
}

// 逐个检查每个 /* ... */ 是否闭合
let i = 0;
let depth = 0;
const problems = [];
while (i < css.length) {
  if (css[i] === '/' && css[i + 1] === '*') {
    if (depth > 0) problems.push(`位置 ${i}: 注释里又开了 /*（嵌套会导致提前闭合）`);
    depth += 1;
    i += 2;
    continue;
  }
  if (css[i] === '*' && css[i + 1] === '/') {
    depth -= 1;
    if (depth < 0) problems.push(`位置 ${i}: 多余的 */`);
    depth = Math.max(0, depth);
    i += 2;
    continue;
  }
  i += 1;
}

console.log(`\n最终注释深度: ${depth}（应为 0）`);
if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const x of problems) console.log('  ✗ ' + x);
} else {
  console.log('注释结构正常');
}
