/**
 * 分析剩余未迁移控件：形态、用法数量、CSS 规则。
 * 用来判断哪些能并入 .btn/.input 契约，哪些需要单独的变体。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = resolve(ROOT, 'apps/web/src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function collect(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'test') continue;
      out.push(...collect(p));
    } else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const files = collect(SRC);

const TARGETS = [
  'chip',
  'attachment-chip',
  'send-btn',
  'view-tab',
  'ui-select-btn',
  'win-btn',
  'folder-toggle',
  'rail-toggle',
  'welcome-example-pill',
  'folder-name-btn',
  'attachment-chip',
];

for (const cls of TARGETS) {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 组件使用次数
  let uses = 0;
  const where = new Set();
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    const re = new RegExp(`class(?:Name|=\\{[^}]*?)["'\`][^"'\`]*\\b${escaped}\\b`, 'g');
    const hits = t.match(re);
    if (hits) {
      uses += hits.length;
      where.add(f.split(/[\\/]/).pop());
    }
  }

  // CSS 规则
  const rules = [];
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^{}]*)\}/gm)) {
    const sel = m[2].trim().replace(/\s+/g, ' ');
    if (new RegExp(`\\.${escaped}(?![a-z0-9-])`).test(sel)) {
      rules.push({ sel, body: m[3].trim().replace(/\s+/g, ' ') });
    }
  }

  console.log(`\n═══ .${cls} ═══`);
  console.log(`  组件使用: ${uses} 处 ${uses ? '（' + [...where].join(', ') + '）' : ''}`);
  console.log(`  CSS 规则: ${rules.length} 条`);
  for (const r of rules.slice(0, 6)) {
    const props = r.body
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^(width|height|padding|background|border|border-radius|font-size|color)/.test(s))
      .join('; ');
    console.log(`    ▸ ${r.sel}`);
    if (props) console.log(`        ${props}`);
  }
  if (rules.length > 6) console.log(`    …还有 ${rules.length - 6} 条`);
}
