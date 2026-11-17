/**
 * 控件级缺陷扫描（v2）。
 *
 * v1 的"溢出"判断是错的：拿子的矩形和父的矩形比，
 * 但父级没有定位上下文时这会大量误报（142 处全是假的）。
 *
 * v2 只保留**可靠可判**的四类：
 * 1. 同类控件高度不一致
 * 2. 文字被裁切
 * 3. 内容重复
 * 4. 圆角 / 字号不在规格档位
 */
import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';
const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await b.goto('/');
  await sleep(1200);
  await b.evaluate(`document.querySelector('.project-folder')?.click(); true`);
  await sleep(1400);

  const report = await b.evaluate(`(() => {
    const out = [];

    // ---- 1. 同类控件高度不一致 ----
    for (const [name, sel] of [['按钮', '.btn'], ['列表项', '.list-item'], ['页签', '.view-tab, .rail-tab']]) {
      const bySize = new Map();
      for (const el of document.querySelectorAll(sel)) {
        const h = Math.round(el.getBoundingClientRect().height);
        if (h === 0) continue;
        const size = [...el.classList].find((c) => /^(btn--|item--)?(sm|md|lg)$/.test(c)) || '未标尺寸';
        if (!bySize.has(size)) bySize.set(size, new Map());
        const m = bySize.get(size);
        if (!m.has(h)) m.set(h, el.tagName + '.' + String(el.className).slice(0, 40));
      }
      for (const [size, hs] of bySize) {
        if (hs.size > 1) {
          out.push({ kind: '高度不一致', sel: name + ' / ' + size, detail: [...hs.keys()].join(' / ') + ' px → ' + [...hs.values()][0] });
        }
      }
    }

    // ---- 2. 文字被裁切（没有省略号兜底）----
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue; // 只看叶子
      const cs = getComputedStyle(el);
      if (cs.overflow !== 'hidden' || cs.textOverflow === 'ellipsis') continue;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        out.push({ kind: '裁切', sel: el.tagName + '.' + String(el.className).slice(0, 40), detail: el.scrollWidth + ' > ' + el.clientWidth + ' 「' + (el.textContent || '').trim().slice(0, 20) + '」' });
      }
    }

    // ---- 3. 内容重复 ----
    const railLabel = document.querySelector('.rail-label')?.textContent?.trim();
    const firstTab = document.querySelector('.rail-tab')?.textContent?.trim();
    if (railLabel && firstTab && railLabel === firstTab) {
      out.push({ kind: '内容重复', sel: '.rail-label / .rail-tab', detail: '右栏标题与第一个页签都叫「' + railLabel + '」' });
    }

    // ---- 4. 圆角不在规格档位 ----
    const ALLOWED = new Set(['0px', '2px', '3px', '4px', '5px', '6px', '8px', '10px', '12px', '14px', '16px', '20px', '28px', '50%', '999px']);
    const odd = new Map();
    for (const el of document.querySelectorAll('*')) {
      const r = getComputedStyle(el).borderRadius;
      if (!r || r === '0px' || ALLOWED.has(r) || r.includes('/')) continue;
      if (!odd.has(r)) odd.set(r, new Set());
      if (odd.get(r).size < 4) odd.get(r).add(el.tagName + '.' + String(el.className).slice(0, 26));
    }
    for (const [r, els] of odd) out.push({ kind: '圆角不在档位', sel: r, detail: [...els].join(' , ') });

    // ---- 5. 字号不在档位 ----
    const FS_ALLOWED = [11, 12, 12.96, 13, 13.5, 14.04, 15, 16.2, 17, 18.36];
    const oddFs = new Map();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      const near = FS_ALLOWED.some((a) => Math.abs(a - fs) < 0.3);
      if (near) continue;
      if (!oddFs.has(fs)) oddFs.set(fs, new Set());
      if (oddFs.get(fs).size < 3) oddFs.get(fs).add(el.tagName + '.' + String(el.className).slice(0, 26));
    }
    for (const [fs, els] of oddFs) out.push({ kind: '字号不在档位', sel: fs + 'px', detail: [...els].join(' , ') });

    return out;
  })()`);

  console.log(`发现 ${report.length} 个控件级问题\n`);
  const by = {};
  for (const p of report) (by[p.kind] ||= []).push(p);
  for (const [k, list] of Object.entries(by)) {
    console.log(`## ${k}（${list.length}）`);
    for (const p of list.slice(0, 12)) console.log(`  ${p.sel}\n    ${p.detail}`);
    if (list.length > 12) console.log(`  …还有 ${list.length - 12} 处`);
    console.log('');
  }
} finally {
  await b.close();
}
