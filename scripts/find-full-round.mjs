/**
 * 找出样式表里所有"全圆角"规则（正圆或胶囊），并报告缺 opt-out 的。
 *
 * ## 判据
 *
 * border-radius 的值命中任一：
 *   - `50%` / `100%`
 *   - `>= 99px`（大到必然超过盒子尺寸）
 *   - `calc(var(--h-*) / 2)`（胶囊）
 *   - `var(--r-full)`（指向 50% 的令牌）
 *
 * ## 踩过的坑
 *
 * `calc(var(--h-md) / 2)` 里含空格。最初按 `split(/\s+/)` 逐段匹配，
 * 值被切成 `calc(var(--h-md)` / `/` / `2)` 三块，正则对不上——
 * **所有胶囊元素都被漏检**。现在先整体匹配胶囊再加空格拆。
 *
 * 这个 bug 是测试里的自测用例抓出来的，所以这里的判据和
 * `cornerShape.test.ts` 保持一致。
 */
import { readFileSync } from 'node:fs';

const FILES = ['apps/web/src/styles.css', 'apps/web/src/ui.css'];

export function isFullRound(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (/^calc\(\s*var\(--h-[a-z]+\)\s*\/\s*2\s*\)$/.test(compact)) return true;
  return compact.split(' ').some((part) => {
    if (part === '50%' || part === '100%') return true;
    if (part.endsWith('px') && Number.parseFloat(part) >= 99) return true;
    if (part === 'var(--r-full)') return true;
    return false;
  });
}

/** 解析成规则列表。 */
function parseRules(css, file) {
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(noComment)) !== null) {
    const selectors = (m[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const declarations = (m[2] ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      });
    rules.push({ selectors, declarations, file });
  }
  return rules;
}

const all = FILES.flatMap((f) => parseRules(readFileSync(f, 'utf8'), f));
const fullRound = all.filter((r) =>
  r.declarations.some(([p, v]) => p === 'border-radius' && isFullRound(v)),
);
const unpaired = fullRound.filter(
  (r) => !r.declarations.some(([p, v]) => p === 'corner-shape' && v === 'round'),
);

console.log(`全圆角规则 ${fullRound.length} 条，缺 opt-out ${unpaired.length} 条`);
if (unpaired.length) {
  for (const r of unpaired) {
    const br = r.declarations.find(([p]) => p === 'border-radius')?.[1];
    console.log(`  ✗ ${r.file}  ${r.selectors.join(', ').slice(0, 70)}`);
    console.log(`      border-radius: ${br}`);
  }
  process.exit(1);
}
console.log('全部已配对 corner-shape: round ✓');
