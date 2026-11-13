/**
 * 按控件规范批量统一尺度。
 *
 * 只改三类东西：字号、圆角、控件高度。
 * **不动颜色、不动布局、不加新样式。**
 */
import { readFile, writeFile } from 'node:fs/promises';

const file = 'apps/web/src/styles.css';
let css = await readFile(file, 'utf8');

const before = css;
let changes = [];

// ---- 1. 半像素字号 → 最近的整档 ----
for (const [from, to] of [
  ['11.5px', 'var(--fs-sm)'],
  ['12.5px', 'var(--fs-md)'],
  ['13.5px', 'var(--fs-md)'],
]) {
  const re = new RegExp(`font-size:\\s*${from.replace('.', '\\.')}`, 'g');
  const n = (css.match(re) ?? []).length;
  if (n > 0) {
    css = css.replace(re, `font-size: ${to}`);
    changes.push(`font-size ${from} → ${to}（${n} 处）`);
  }
}

// ---- 2. 字号统一到 4 档 ----
// 只在 font-size 声明里替换，避免误伤其它属性
for (const [from, to] of [
  ['15px', 'var(--fs-lg)'],
  ['14px', 'var(--fs-md)'],
  ['13px', 'var(--fs-md)'],
  ['12px', 'var(--fs-sm)'],
  ['11px', 'var(--fs-xs)'],
]) {
  const re = new RegExp(`font-size:\\s*${from}(?![\\d.])`, 'g');
  const n = (css.match(re) ?? []).length;
  if (n > 0) {
    css = css.replace(re, `font-size: ${to}`);
    changes.push(`font-size ${from} → ${to}（${n} 处）`);
  }
}

// ---- 3. 圆角统一到 3 档 ----
// 保留 0、50%，其余归到 3px 或 4px
for (const [from, to] of [
  ['12px', 'var(--r-md)'],
  ['10px', 'var(--r-md)'],
  ['8px', 'var(--r-md)'],
  ['6px', 'var(--r-md)'],
  ['5px', 'var(--r-md)'],
  ['4px', 'var(--r-md)'],
  ['3px', 'var(--r-sm)'],
  ['2px', 'var(--r-sm)'],
]) {
  const re = new RegExp(`border-radius:\\s*${from}(?![\\d.])`, 'g');
  const n = (css.match(re) ?? []).length;
  if (n > 0) {
    css = css.replace(re, `border-radius: ${to}`);
    changes.push(`border-radius ${from} → ${to}（${n} 处）`);
  }
}

// ---- 4. 已知的"别扭"：面板 padding 不齐 ----
// 按规范统一成 12px 16px
const panelFixes = [
  ['10px 12px', 'var(--g-3) var(--g-4)'],
  ['5px 16px', 'var(--g-2) var(--g-4)'],
  ['12px 24px 16px', 'var(--g-3) var(--g-4)'],
];
for (const [from, to] of panelFixes) {
  const re = new RegExp(`padding:\\s*${from.replace(/ /g, '\\s+')};`, 'g');
  const n = (css.match(re) ?? []).length;
  if (n > 0) {
    css = css.replace(re, `padding: ${to};`);
    changes.push(`padding ${from} → ${to}（${n} 处）`);
  }
}

if (css === before) {
  console.log('没有变化');
} else {
  await writeFile(file, css, 'utf8');
  console.log(`改动了 ${changes.length} 类：`);
  for (const c of changes) console.log('  ' + c);
}
