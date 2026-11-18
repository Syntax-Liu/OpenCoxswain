/**
 * 扫描真实界面里**没有走控件层**的可交互元素。
 *
 * ## 判断依据
 *
 * 控件层的标记类：
 *   .btn / .list-item / .option-item / .input / .send-btn / .field
 *
 * 一个可交互元素（button / input / textarea / a[href]）如果
 * **不带任何控件层标记**，就是"自己写的一套"——它的高度、圆角、
 * 字号极可能与规格不一致。
 *
 * ## 同时量出偏差
 *
 * 对这些元素，量它们的圆角/字号/高度，与规格比对：
 * - 圆角：应为 4px（--r-xs）或 8px（--r-sm）
 * - 字号：应为 14.04（--fs-sm）
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

const SCAN = String.raw`(() => {
  const CONTROL = ['btn', 'list-item', 'option-item', 'input', 'send-btn', 'field', 'dot'];
  const hasControl = (el) => CONTROL.some((c) => el.classList.contains(c));

  const out = [];
  const seen = new Set();

  for (const el of document.querySelectorAll('button, input, textarea, [role="button"]')) {
    if (hasControl(el)) continue;
    // 跳过完全没有样式的（display:none 之类）
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;

    const cls = [...el.classList].join('.');
    const key = el.tagName + '.' + cls;
    if (seen.has(key)) continue;
    seen.add(key);

    const cs = getComputedStyle(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: cls || '(无类)',
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: cs.borderRadius,
      fontSize: cs.fontSize,
      hasBorder: cs.borderTopWidth !== '0px',
      hasBg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
    });
  }
  return out;
})()`;

/** 依次走几个主要页面。 */
const STEPS = [
  ['首页', null],
  [
    '设置',
    `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent || ''));
      b?.click(); return !!b;
    })()`,
  ],
  [
    '命令面板',
    `(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      return true;
    })()`,
  ],
];

const all = [];
try {
  for (const [label, script] of STEPS) {
    await b.goto('/');
    await sleep(1400);
    if (script) {
      await b.evaluate(script);
      await sleep(1000);
    }
    const rows = await b.evaluate(SCAN);
    for (const r of rows) all.push({ ...r, page: label });
  }
} finally {
  await b.close();
}

// 去重（同一类名只留一条）
const unique = new Map();
for (const r of all) if (!unique.has(r.tag + r.cls)) unique.set(r.tag + r.cls, r);
const list = [...unique.values()];

if (list.length === 0) {
  console.log('没有发现未走控件层的元素 ✓');
  process.exit(0);
}

console.log(`发现 ${list.length} 个未走控件层的可交互元素\n`);

// 按偏差严重程度排序：圆角不是 4/8 且 > 10px 的排前面
const odd = list.filter((r) => {
  const rad = parseFloat(r.radius);
  return !Number.isNaN(rad) && rad !== 0 && rad !== 4 && rad !== 8;
});

console.log(`**其中 ${odd.length} 个圆角不在规格档位（0/4/8）**\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('页面', 10), pad('元素', 40), pad('尺寸', 12), pad('圆角', 8), '字号');
console.log('-'.repeat(92));
for (const r of [...odd, ...list.filter((x) => !odd.includes(x))].slice(0, 40)) {
  console.log(
    pad(r.page, 10),
    pad(`${r.tag}.${r.cls}`.slice(0, 40), 40),
    pad(`${r.w}×${r.h}`, 12),
    pad(r.radius, 8),
    r.fontSize,
  );
}
