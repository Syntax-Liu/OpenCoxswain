/**
 * IconButton 现状测量 + 遗留散落实现清点。
 *
 * 先探活（ui-dev-guide 7.7）。
 */
import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';
const health = await fetch(`${BASE}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPENCOXSWAIN_TOKEN ?? 'audit-token-123'}` },
}).catch(() => null);
if (!health?.ok) throw new Error(`审计服务没起来（${BASE}）`);

const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = String.raw`(() => {
  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('.btn--icon, .btn--icon-md')) {
    const key = [...el.classList].filter((c) => /btn--/.test(c)).join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push({
      cls: key,
      w: Math.round(r.width),
      h: Math.round(r.height),
      square: Math.abs(r.width - r.height) < 1,
      padding: cs.padding,
      radius: cs.borderRadius,
      iconSize: el.querySelector('svg')?.getBoundingClientRect().width?.toFixed(0) ?? '-',
    });
  }
  return rows;
})()`;

try {
  await b.goto('/');
  await sleep(1600);
  const rows = await b.evaluate(MEASURE);

  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('首页没有图标按钮，尝试打开设置页');
  }

  console.log(`发现 ${rows.length} 种图标按钮实例\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('类名', 42), pad('尺寸', 10), pad('正方', 6), pad('padding', 12), pad('圆角', 8), '图标');
  console.log('-'.repeat(96));
  for (const r of rows) {
    console.log(
      pad(r.cls, 42),
      pad(`${r.w}×${r.h}`, 10),
      pad(r.square ? '✓' : '✗', 6),
      pad(r.padding, 12),
      pad(r.radius, 8),
      r.iconSize,
    );
  }
} finally {
  await b.close();
}
