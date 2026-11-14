/**
 * 修正 --color-danger-dim：它被写在了语义层却直接给了 rgba 值，
 * 违反「只有原始层允许写色值」的约定（tokens.test.ts 已捕获）。
 *
 * 正确做法：色值进原始层，语义层只引用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '../apps/web/src/styles.css');
const dry = process.argv.includes('--dry');
let css = readFileSync(CSS_PATH, 'utf8');

// 1) 原始层补色值
const primAnchor = '  --c-scrim-55: rgba(0, 0, 0, 0.55);';
if (!css.includes(primAnchor)) {
  console.error('未找到原始层锚点');
  process.exit(1);
}
if (!css.includes('--c-danger-15:')) {
  css = css.replace(
    primAnchor,
    primAnchor + '\r\n  --c-danger-15: rgba(184, 84, 80, 0.15);',
  );
  console.log('  ✓ 原始层补充 --c-danger-15');
}

// 2) 语义层改为引用
const bad = '  --color-danger-dim: rgba(184, 84, 80, 0.15);';
const good = '  --color-danger-dim: var(--c-danger-15);';
if (css.includes(bad)) {
  css = css.replace(bad, good);
  console.log('  ✓ 语义层改为引用原始层');
} else if (css.includes(good)) {
  console.log('  · 已是引用形式');
} else {
  console.error('  ✗ 未找到 --color-danger-dim 定义');
  process.exit(1);
}

// 3) 校验：语义层不得有裸色值
const nc = css.replace(/\/\*[\s\S]*?\*\//g, '');
const violations = [...nc.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)]
  .filter((m) => !/^var\(--c-/.test((m[2] ?? '').trim()))
  .map((m) => m[1]);
console.log(violations.length ? `  ✗ 仍有违例: ${violations.join(', ')}` : '  ✓ 语义层全部引用原始层');

const o = (nc.match(/\{/g) ?? []).length;
const c = (nc.match(/\}/g) ?? []).length;
if (o !== c) {
  console.error('花括号不平衡');
  process.exit(1);
}

if (!dry) {
  writeFileSync(CSS_PATH, css, 'utf8');
  console.log('已写盘');
}
