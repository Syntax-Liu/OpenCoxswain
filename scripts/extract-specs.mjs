/**
 * 从样式表提取控件的**真实规格**，供文档使用。
 *
 * 为什么不用手写：文档里的数字最容易腐烂。这个脚本直接从
 * `ui.css` + `styles.css` 抽出当前生效的声明，写文档时照抄。
 */
import { readFileSync } from 'node:fs';

const SRC = 'apps/web/src';
const css = `${readFileSync(`${SRC}/styles.css`, 'utf8')}\n${readFileSync(`${SRC}/ui.css`, 'utf8')}`;
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取某选择器的全部声明（同名规则后来的覆盖前面的）。 */
function decl(selector) {
  const map = new Map();
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[,\\s])${esc}\\s*\\{([^}]*)\\}`, 'g');
  let m;
  while ((m = re.exec(clean)) !== null) {
    for (const part of (m[1] ?? '').split(';')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k && v) map.set(k, v);
    }
  }
  return map;
}

/** 取令牌值。 */
function token(name) {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(clean);
  return m ? m[1].trim() : null;
}

console.log('## 令牌实际值\n');
for (const name of ['fs-xs', 'fs-sm', 'fs-md', 'fs-lg', 'lh-tight', 'lh-normal', 'lh-loose',
  'h-sm', 'h-md', 'h-lg', 'r-xs', 'r-sm', 'r-md', 'r-lg', 'r-full',
  'g-05', 'g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'font-scale']) {
  console.log(`  --${name.padEnd(12)} ${token(name) ?? '(未定义)'}`);
}

console.log('\n## 控件规格\n');
const CONTROLS = [
  ['Button 基础', '.btn'],
  ['Button sm', '.btn--sm'],
  ['Button md', '.btn--md'],
  ['Button lg', '.btn--lg'],
  ['Button 图标', '.btn--icon'],
  ['ListItem 基础', '.list-item'],
  ['ListItem compact', '.list-item--compact'],
  ['ListItem roomy', '.list-item--roomy'],
  ['OptionItem 基础', '.option-item'],
  ['Input 基础', '.input'],
  ['Input sm', '.input.input--sm'],
];

for (const [label, sel] of CONTROLS) {
  const d = decl(sel);
  if (d.size === 0) {
    console.log(`  ${label}（${sel}）: 未找到`);
    continue;
  }
  const keys = ['height', 'width', 'padding', 'border-radius', 'font-size', 'line-height', 'gap', 'min-height'];
  const parts = keys.filter((k) => d.has(k)).map((k) => `${k}: ${d.get(k)}`);
  console.log(`  ${label}`);
  console.log(`    ${parts.join('  |  ') || '(无尺寸声明)'}`);
}
