/**
 * 剩余 28 处裸色值的处理。
 *
 * 分类：
 *   A. 阴影（6 处）→ 统一 --shadow-* 令牌
 *   B. 遮罩类深色底（notice / approval / update 等 6 处）→ 语义令牌
 *   C. 代码高亮（.md-body / .md-code 4 处）→ **保留外观**，但移到原始层集中管理
 *   D. 轨迹分色（trace-seg 6 处）→ 移到原始层（这是有意义的数据可视化配色）
 *   E. 窗口控制（win-close）→ 固定系统色，保留在原始层
 *   F. .main 的 #000 边框 → 结构分隔线令牌
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '../apps/web/src/styles.css');
const dry = process.argv.includes('--dry');
let css = readFileSync(CSS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// A. 原始层新增：代码高亮 / 轨迹分色 / 窗口控制（都是"有意义的固定配色"）
// ---------------------------------------------------------------------------
const PRIM_ANCHOR = '  --c-danger-15: rgba(184, 84, 80, 0.15);';
const PRIM = [
  '',
  '  /* 代码高亮：沿用 VS Code 暗色配色，换主题时只需改这里 */',
  '  --c-code-bg: #2d2d2d;',
  '  --c-code-fg: #ce9178;',
  '  --c-code-block: #1a1a1a;',
  '  --c-code-inline: #0b0d12;',
  '',
  '  /* 轨迹分色：用户 / 助理 / 工具三条泳道，颜色本身是信息 */',
  '  --c-trace-user: #4a7fb5;',
  '  --c-trace-assistant: #7a5aa8;',
  '  --c-trace-tool: #3f6b52;',
  '',
  '  /* 窗口关闭按钮的悬停红（Windows 标准色） */',
  '  --c-window-close: #c42b1c;',
];
if (!css.includes(PRIM_ANCHOR)) {
  console.error('未找到原始层锚点');
  process.exit(1);
}
if (!css.includes('--c-code-bg:')) {
  css = css.replace(PRIM_ANCHOR, PRIM_ANCHOR + '\r\n' + PRIM.join('\r\n'));
  console.log('  ✓ 原始层补充代码高亮/轨迹/窗口色');
}

// 语义层别名（供组件引用）
const SEM_ANCHOR = '  --color-danger-dim: var(--c-danger-15);';
const SEM = [
  '  --color-code-bg: var(--c-code-bg);',
  '  --color-code-fg: var(--c-code-fg);',
  '  --color-code-block: var(--c-code-block);',
  '  --color-code-inline: var(--c-code-inline);',
  '  --color-trace-user: var(--c-trace-user);',
  '  --color-trace-assistant: var(--c-trace-assistant);',
  '  --color-trace-tool: var(--c-trace-tool);',
];
if (!css.includes(SEM_ANCHOR)) {
  console.error('未找到语义层锚点');
  process.exit(1);
}
if (!css.includes('--color-code-bg:')) {
  css = css.replace(SEM_ANCHOR, SEM_ANCHOR + '\r\n' + SEM.join('\r\n'));
  console.log('  ✓ 语义层补充对应别名');
}

// ---------------------------------------------------------------------------
// B. 组件区替换
// ---------------------------------------------------------------------------
const rootEnd = css.indexOf('}', css.indexOf('--c-window-close'));
let head = css.slice(0, css.indexOf(':root'));
let tail = css.slice(css.indexOf(':root'));

// 先把原始层与语义层定义保护起来（它们含 # 值，不能替换）
const primLayerEnd = tail.indexOf('}', tail.indexOf(':root'));
const primLayer = tail.slice(0, primLayerEnd + 1);
let comp = tail.slice(primLayerEnd + 1);

const REPLACEMENTS = [
  // A 阴影
  ['0 4px 12px rgba(0, 0, 0, 0.35)', 'var(--shadow-popover)'],
  ['0 4px 12px rgba(0, 0, 0, 0.4)', 'var(--shadow-popover)'],
  ['0 8px 24px rgba(0, 0, 0, 0.45)', 'var(--shadow-menu)'],
  ['0 4px 12px rgba(0, 0, 0, 0.3)', 'var(--shadow-popover)'],
  // 兜底：剩余任何 box-shadow 里的黑色 rgba
  ['rgba(0, 0, 0, 0.35)', 'var(--c-scrim-45)'],
  ['rgba(0, 0, 0, 0.4)', 'var(--c-scrim-45)'],
  ['rgba(0, 0, 0, 0.45)', 'var(--c-scrim-45)'],
  ['rgba(0, 0, 0, 0.3)', 'var(--c-scrim-45)'],
  // C 代码高亮
  ['background: #2d2d2d', 'background: var(--color-code-bg)'],
  ['color: #ce9178', 'color: var(--color-code-fg)'],
  ['background: #1a1a1a', 'background: var(--color-code-block)'],
  ['background: #0b0d12', 'background: var(--color-code-inline)'],
  // D 轨迹分色
  ['#4a7fb5', 'var(--color-trace-user)'],
  ['#7a5aa8', 'var(--color-trace-assistant)'],
  ['#3f6b52', 'var(--color-trace-tool)'],
  // E 窗口控制
  ['#c42b1c', 'var(--c-window-close)'],
  // F 结构分隔线
  ['border-left: 1px solid #000', 'border-left: 1px solid var(--color-border-divider)'],
  // B 深色底：提示条 / 审批 / 更新横幅
  ['background: #241d0d', 'background: var(--color-warn-dim)'],
  ['background: #1f1a0e', 'background: var(--color-warn-dim)'],
  ['background: #4a3a12', 'background: var(--color-warn-dim)'],
  ['background: #10202e', 'background: var(--color-info-dim)'],
  ['border-bottom: 1px solid #1d3a52', 'border-bottom: 1px solid var(--color-info)'],
  ['background: #13202b', 'background: var(--color-info-dim)'],
  ['background: #2b2027', 'background: var(--color-danger-dim)'],
  ['color: #ffd9d9', 'color: var(--color-danger)'],
];

let hits = 0;
for (const [from, to] of REPLACEMENTS) {
  if (comp.includes(from)) {
    comp = comp.split(from).join(to);
    hits += 1;
  }
}
console.log(`  ✓ 组件区替换 ${hits} 组`);

css = head + primLayer + comp;

// 补 warn-dim / info-dim
const SEM2 = [
  '  --color-warn-dim: rgba(107, 82, 22, 0.35);',
  '  --color-info-dim: rgba(29, 58, 82, 0.35);',
];
for (const line of SEM2) {
  const name = line.trim().split(':')[0];
  if (!css.includes(name + ':')) {
    css = css.replace('  --color-danger-dim: var(--c-danger-15);', '  --color-danger-dim: var(--c-danger-15);\r\n' + line);
    console.log(`  ✓ 补充 ${name}`);
  }
}

// 这些 dim 色也需要从原始层来——先检查是否违例
const nc = css.replace(/\/\*[\s\S]*?\*\//g, '');
const violations = [...nc.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)]
  .filter((m) => !/^var\(--c-/.test((m[2] ?? '').trim()))
  .map((m) => m[1]);
if (violations.length) {
  console.log(`  ⚠ 语义层仍有裸值，需移入原始层: ${violations.join(', ')}`);
}

const o = (nc.match(/\{/g) ?? []).length;
const c = (nc.match(/\}/g) ?? []).length;
console.log(`  花括号: ${o}/${c} ${o === c ? '平衡' : '不平衡'}`);
if (o !== c) process.exit(1);

if (!dry) {
  writeFileSync(CSS_PATH, css, 'utf8');
  console.log('\n已写盘');
} else {
  console.log('\n(--dry)');
}
