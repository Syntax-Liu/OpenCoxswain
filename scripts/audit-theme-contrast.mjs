/**
 * 主题对比度审计（WCAG 2.1）+ 修复建议。
 *
 * 背景：主题切换只是"能切"，不代表"切完还看得清"。
 * 本脚本同时输出**建议的替代色值**——在保持色相的前提下把亮度调到刚过阈值。
 *
 * 用法：
 *   node scripts/audit-theme-contrast.mjs          只看报告
 *   node scripts/audit-theme-contrast.mjs --suggest 附带建议值
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(import.meta.dirname, '../apps/web/src/styles.css');
const css = readFileSync(CSS_PATH, 'utf8');
const suggest = process.argv.includes('--suggest');

function parseBlock(source) {
  const map = new Map();
  for (const m of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  return map;
}

const darkMatch = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
const lightMatch = /:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(css);
const darkBlock = parseBlock(darkMatch ? darkMatch[1] : '');
const lightBlock = parseBlock(lightMatch ? lightMatch[1] : '');

function parseColor(v) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(v.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
  if (rgb) {
    const p = rgb[1].split(',').map((s) => parseFloat(s.trim()));
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  }
  return null;
}

function lum([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 按比例把颜色朝黑/白推，直到满足对比度。返回 hex。 */
function adjust(color, bg, target, darken) {
  const to = darken ? [0, 0, 0] : [255, 255, 255];
  let best = color;
  for (let step = 0; step <= 100; step += 1) {
    const t = step / 100;
    const c = color.map((v, i) => Math.round(v + (to[i] - v) * t));
    best = c;
    if (ratio(c, bg) >= target) break;
  }
  return '#' + best.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** 语义令牌 → 其引用的原始令牌。 */
const semanticMap = new Map();
for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*(--color-[\w-]+):\s*var\((--[\w-]+)\);/gm)) {
  semanticMap.set(m[1], m[2]);
}

const SURFACES = {
  '--color-surface-canvas': 'canvas',
  '--color-surface-sidebar': 'sidebar',
  '--color-surface-panel': 'panel',
  '--color-surface-raised': 'raised',
};

const TEXT = {
  '--color-label-primary': 4.5,
  '--color-label-secondary': 4.5,
  '--color-label-tertiary': 3.0,
  '--color-label-strong': 4.5,
  '--color-danger': 4.5,
  '--color-success': 4.5,
  '--color-warn': 3.0,
  '--color-info': 3.0,
  '--color-action': 3.0,
};

function resolveIn(theme, block, name) {
  const primName = name.startsWith('--c-') ? name : semanticMap.get(name);
  if (!primName) return null;
  const raw = block.get(primName);
  if (!raw) return null;
  return parseColor(raw);
}

const THEMES = [
  { name: 'dark', block: (b, n) => resolveIn('dark', b, n) },
  { name: 'light', block: (b, n) => resolveIn('light', b, n) },
];

let fails = 0;
let total = 0;
const suggestions = [];

for (const theme of THEMES) {
  console.log(`\n═══ ${theme.name} ═══`);
  for (const [token, min] of Object.entries(TEXT)) {
    const primName = semanticMap.get(token);
    const fg = theme.block(
      theme.name === 'light' ? lightBlock : darkBlock,
      token,
    );
    if (!fg || !primName) continue;

    let worst = null;
    for (const [surface, label] of Object.entries(SURFACES)) {
      const bg = theme.block(theme.name === 'light' ? lightBlock : darkBlock, surface);
      if (!bg) continue;
      const r = ratio(fg, bg);
      total += 1;
      if (!worst || r < worst.r) worst = { r, bg, label };
    }
    if (!worst) continue;

    const ok = worst.r >= min;
    if (!ok) {
      fails += 1;
      // 浅色主题：字要比背景暗 → 朝黑推；深色主题：朝白推
      const cand = adjust(fg, worst.bg, min + 0.05, theme.name === 'light');
      suggestions.push({
        theme: theme.name,
        prim: primName,
        current: currentHex(theme.name === 'light' ? lightBlock : darkBlock, primName),
        suggested: cand,
        was: worst.r,
        need: min,
      });
      console.log(
        `  ✗ ${token.replace('--color-', '').padEnd(18)} ${worst.r.toFixed(2)}:1 (需 ${min}) 最差于 ${worst.label}`,
      );
    }
  }
}

function currentHex(block, name) {
  const raw = block.get(name);
  return raw ?? '';
}

console.log(`\n检查 ${total} 组，不达标 ${fails} 组`);

if (suggest && suggestions.length) {
  console.log('\n建议修改（原始层，按主题）：');
  for (const s of suggestions) {
    console.log(`  [${s.theme}] ${s.prim.padEnd(18)} ${s.current} → ${s.suggested}   (${s.was.toFixed(2)} → ≥${s.need})`);
  }
}
