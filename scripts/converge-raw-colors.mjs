/**
 * 把组件区裸色值收敛到语义令牌。
 *
 * 分四类处理，每类理由不同：
 *   A. 阴影 → 统一成 --shadow-*（深浅主题各一套，靠令牌切换）
 *   B. 遮罩 → --color-scrim
 *   C. 语义明确的 → 状态令牌（成功/危险/警告/信息）
 *   D. 代码高亮等 VS Code 配色 → 保留但移到原始层，集中管理
 *
 * 判定依据：这些颜色写死后**不会跟随浅色主题切换**，是主题切换的隐患。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '../apps/web/src/styles.css');
const dry = process.argv.includes('--dry');
let css = readFileSync(CSS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 1) 在原始层补充需要的色值（集中管理），在语义层加对应别名
// ---------------------------------------------------------------------------
const PRIMITIVE_ADDITIONS = [
  '  /* 遮罩与阴影：组件里曾直接写 rgba(0,0,0,.x)，改成令牌以便按主题调整 */',
  '  --c-scrim-45: rgba(0, 0, 0, 0.45);',
  '  --c-scrim-50: rgba(0, 0, 0, 0.5);',
  '  --c-scrim-55: rgba(0, 0, 0, 0.55);',
];

const SEMANTIC_ADDITIONS = [
  '  /* 遮罩与阴影：阴影用 rgba 在黑底上才自然；浅色主题里换成更淡的值 */',
  '  --color-scrim: var(--c-scrim-50);',
  '  --shadow-popover: 0 4px 12px var(--c-scrim-45);',
  '  --shadow-menu: 0 8px 24px var(--c-scrim-55);',
  '  --shadow-modal: 0 8px 32px var(--c-scrim-50);',
];

function insertAfter(anchor, lines) {
  if (!css.includes(anchor)) return false;
  if (css.includes(lines[0])) return true; // 幂等
  css = css.replace(anchor, anchor + '\r\n' + lines.join('\r\n'));
  return true;
}

const primOk = insertAfter('  --c-overlay-20: rgba(255, 255, 255, 0.2);', PRIMITIVE_ADDITIONS);
const semOk = insertAfter('  --color-border-focus: var(--c-amber-400);', SEMANTIC_ADDITIONS);
console.log(`原始层补充: ${primOk ? '✓' : '✗'}   语义层补充: ${semOk ? '✓' : '✗'}`);

// ---------------------------------------------------------------------------
// 2) 组件区替换：值 → 令牌
// ---------------------------------------------------------------------------
const VALUE_MAP = [
  // 阴影
  ['0 4px 12px rgba(0, 0, 0, 0.5)', 'var(--shadow-popover)'],
  ['0 4px 12px rgba(0, 0, 0, 0.45)', 'var(--shadow-popover)'],
  ['0 8px 24px rgba(0, 0, 0, 0.5)', 'var(--shadow-menu)'],
  ['0 8px 24px rgba(0, 0, 0, 0.4)', 'var(--shadow-menu)'],
  ['0 8px 24px rgba(0, 0, 0, 0.6)', 'var(--shadow-menu)'],
  ['0 8px 32px rgba(0, 0, 0, 0.5)', 'var(--shadow-modal)'],
  ['0 4px 12px rgba(0, 0, 0, 0.4)', 'var(--shadow-popover)'],
  ['0 4px 12px rgba(0, 0, 0, 0.35)', 'var(--shadow-popover)'],
  // 遮罩
  ['rgba(0, 0, 0, 0.55)', 'var(--color-scrim)'],
  ['rgba(0, 0, 0, 0.5)', 'var(--color-scrim)'],
  ['rgba(4, 6, 8, 0.55)', 'var(--color-scrim)'],
  ['rgba(10, 12, 15, 0.85)', 'var(--color-scrim-strong)'],
  // 语义色：失败 / 成功 / 警告 / 信息
  ['#5a3030', 'var(--color-danger)'],
  ['#24513c', 'var(--color-success)'],
  ['#6b5216', 'var(--color-warn)'],
  ['#f14c4c', 'var(--color-danger)'],
  ['#4ec9b0', 'var(--color-success)'],
  ['#dcdcaa', 'var(--color-warn)'],
  ['#4a5266', 'var(--color-label-tertiary)'],
  ['#6e6e6e', 'var(--color-label-tertiary)'],
  ['#c42b1c', 'var(--color-danger)'],
  ['#04395e', 'var(--color-surface-selected)'],
  ['rgba(241, 76, 76, 0.15)', 'var(--color-danger-dim)'],
  ['rgba(0, 120, 212, 0.08)', 'var(--color-surface-hover)'],
];

// 只在组件区替换（不含 :root）
const rootEnd = css.indexOf('}', css.indexOf(':root'));
let head = css.slice(0, rootEnd);
let tail = css.slice(rootEnd);

let replaceCount = 0;
for (const [from, to] of VALUE_MAP) {
  const before = tail;
  tail = tail.split(from).join(to);
  if (tail !== before) replaceCount += 1;
}
css = head + tail;
console.log(`组件区替换命中 ${replaceCount} 组`);

// 需要补的语义别名
const EXTRA_SEMANTIC = ['  --color-scrim-strong: var(--c-scrim-55);', '  --color-danger-dim: rgba(184, 84, 80, 0.15);'];
for (const line of EXTRA_SEMANTIC) {
  if (!css.includes(line)) {
    css = css.replace('  --color-scrim: var(--c-scrim-50);', '  --color-scrim: var(--c-scrim-50);\r\n' + line);
  }
}

// ---------------------------------------------------------------------------
// 3) 校验
// ---------------------------------------------------------------------------
const nc = css.replace(/\/\*[\s\S]*?\*\//g, '');
const o = (nc.match(/\{/g) ?? []).length;
const c = (nc.match(/\}/g) ?? []).length;
console.log(`花括号: ${o}/${c} ${o === c ? '平衡' : '不平衡'}`);
if (o !== c) process.exit(1);

const comp = nc.slice(nc.indexOf('}', nc.indexOf(':root')));
const left = [...comp.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]);
console.log(`组件区剩余裸色值: ${left.length}`);
for (const v of [...new Set(left)]) console.log(`  ${v}`);

if (!dry) {
  css = css.replace(/(\r\n){3,}/g, '\r\n\r\n');
  writeFileSync(CSS_PATH, css, 'utf8');
  console.log('\n已写盘');
} else {
  console.log('\n(--dry) 未写盘');
}
