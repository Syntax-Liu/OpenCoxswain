/**
 * OptionItem 现状测量：各场景类的几何是否一致。
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
  for (const el of document.querySelectorAll('.option-item')) {
    const variant = [...el.classList].find(
      (c) => c !== 'option-item' && c !== 'active' && !c.startsWith('is-'),
    );
    const key = variant || '(只有骨架类)';
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push({
      variant: key,
      h: Math.round(r.height),
      pad: cs.padding,
      radius: cs.borderRadius,
      fontSize: cs.fontSize,
      display: cs.display,
      bg: cs.backgroundColor,
    });
  }
  return rows;
})()`;

try {
  await b.goto('/');
  await sleep(1600);

  // 1) 首页（右栏有 rail-tab）
  let rows = await b.evaluate(MEASURE);

  // 2) 打开设置（那里有 settings-nav-item 等）
  await b.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent || ''));
    btn?.click();
    return !!btn;
  })()`);
  await sleep(1400);
  rows = rows.concat(await b.evaluate(MEASURE));

  // 3) 命令面板（palette 项）
  await b.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    return true;
  })()`);
  await sleep(800);
  rows = rows.concat(await b.evaluate(MEASURE));

  // 去重
  const byVariant = new Map();
  for (const r of rows) if (!byVariant.has(r.variant)) byVariant.set(r.variant, r);
  const list = [...byVariant.values()];

  if (list.length === 0) throw new Error('量不到 OptionItem——不要当成功');

  console.log(`共 ${list.length} 种 OptionItem 场景\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('场景类', 26), pad('高', 5), pad('padding', 20), pad('圆角', 8), pad('字号', 10), '背景');
  console.log('-'.repeat(92));
  for (const r of list) {
    console.log(
      pad(r.variant, 26), pad(r.h, 5), pad(r.pad, 20), pad(r.radius, 8), pad(r.fontSize, 10), r.bg,
    );
  }
} finally {
  await b.close();
}
