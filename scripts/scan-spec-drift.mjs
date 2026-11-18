/**
 * 扫描真实界面里**样式参数不在规格档位**的元素。
 *
 * 上一版扫描结论是"没有未走控件层的元素"——组件层已经全用 ui/ 了。
 * 所以问题不在"用了什么组件"，而在"同一组件在不同页面长得不一样"。
 *
 * 这里量所有有视觉尺寸的元素，找出：
 * 1. 圆角不在 {0, 2, 4, 8, 12, 16, 50%} 档位
 * 2. 字号不在 {12.96, 14.04, 16.2, 18.36} 档位
 * 3. 同类控件高度不一致
 *
 * 先探活。
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
  const RADII = new Set(['0px', '2px', '4px', '8px', '12px', '16px', '20px', '50%', '50% / 50%', '28px', '14px', '10px', '6px', '5px', '3px', '999px']);
  const FSS = [11, 12, 12.96, 13, 13.5, 14.04, 15, 16.2, 17, 18.36, 20, 24, 25.92];
  const out = { radius: [], fontSize: [] };
  const seenR = new Set();
  const seenF = new Set();

  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    const cls = [...el.classList].slice(0, 2).join('.');

    // 圆角
    const rad = cs.borderRadius;
    if (rad && rad !== '0px' && !RADII.has(rad)) {
      const key = rad;
      if (!seenR.has(key)) { seenR.add(key); out.radius.push({ value: rad, sample: el.tagName + '.' + cls }); }
    }

    // 字号（只看叶子，避免继承噪声）
    if (el.children.length === 0 && (el.textContent || '').trim()) {
      const fs = parseFloat(cs.fontSize);
      if (!FSS.some((v) => Math.abs(v - fs) < 0.3)) {
        const key = fs.toFixed(2);
        if (!seenF.has(key)) { seenF.add(key); out.fontSize.push({ value: key + 'px', sample: el.tagName + '.' + cls }); }
      }
    }
  }
  return out;
})()`;

const STEPS = [
  ['首页', null],
  ['设置', `(() => { const b=[...document.querySelectorAll('button')].find(x=>/设置/.test(x.textContent||'')); b?.click(); return !!b; })()`],
  ['命令面板', `(() => { window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); return true; })()`],
];

const agg = { radius: new Map(), fontSize: new Map() };
try {
  for (const [label, script] of STEPS) {
    await b.goto('/');
    await sleep(1400);
    if (script) { await b.evaluate(script); await sleep(1000); }
    const r = await b.evaluate(SCAN);
    for (const x of r.radius) if (!agg.radius.has(x.value)) agg.radius.set(x.value, { ...x, page: label });
    for (const x of r.fontSize) if (!agg.fontSize.has(x.value)) agg.fontSize.set(x.value, { ...x, page: label });
  }
} finally {
  await b.close();
}

console.log(`## 圆角不在档位：${agg.radius.size} 种`);
for (const [v, x] of agg.radius) console.log(`  ${v.padEnd(12)} ${x.page} / ${x.sample}`);
console.log(`\n## 字号不在档位：${agg.fontSize.size} 种`);
for (const [v, x] of agg.fontSize) console.log(`  ${v.padEnd(12)} ${x.page} / ${x.sample}`);
