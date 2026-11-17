/**
 * 控件级缺陷排查：把每个界面状态的**真实渲染**拍下来并量关键尺寸。
 *
 * 与 `shoot-styles.mjs` 的区别：**不注入任何 DOM**，全部是真实交互，
 * 这样量到的才是用户看到的东西。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openBrowser } from './lib/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, '.ui-audit-shots');
const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47911';

mkdirSync(OUT, { recursive: true });

const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await b.goto('/');
  await sleep(1200);

  // 1) 打开项目
  const opened = await b.evaluate(`(() => {
    const f = document.querySelector('.project-folder');
    f?.click();
    return !!f;
  })()`);
  console.log('打开项目:', opened);
  await sleep(1400);

  await b.screenshot('01-project', OUT);

  // 2) 量右栏各部件
  const railInfo = await b.evaluate(`(() => {
    const rail = document.querySelector('.rail');
    if (!rail) return { exists: false, headerClose: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.title || '').filter(Boolean).slice(0, 10) };
    const rect = (sel) => {
      const el = rail.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), display: cs.display, ovf: cs.overflow };
    };
    const items = [...rail.querySelectorAll('.rail-label, .rail-tab, .rail-top')].map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.className, text: (e.textContent || '').trim().slice(0, 8), top: Math.round(r.top), h: Math.round(r.height) };
    });
    return { exists: true, railTop: rect('.rail-top'), railTabs: rect('.rail-tabs'), items };
  })()`);
  console.log('右栏:', JSON.stringify(railInfo, null, 1));

  // 3) 展开右栏
  const toggled = await b.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const t = btns.find((x) => {
      const l = (x.getAttribute('aria-label') || x.title || '').trim();
      return l === '侧边栏' || l === '打开侧边栏' || /侧栏|右栏/.test(l);
    });
    t?.click();
    return t ? (t.getAttribute('aria-label') || t.title) : null;
  })()`);
  console.log('点到的展开按钮:', toggled);
  await sleep(900);
  await b.screenshot('02-rail', OUT);

  // 4) 再量一次
  const after = await b.evaluate(`(() => {
    const rail = document.querySelector('.rail');
    if (!rail) return 'no rail';
    const items = [...rail.querySelectorAll('.rail-label, .rail-tab')].map((e) => {
      const r = e.getBoundingClientRect();
      return { cls: e.className, text: (e.textContent || '').trim().slice(0, 8), top: Math.round(r.top), h: Math.round(r.height) };
    });
    return JSON.stringify(items, null, 1);
  })()`);
  console.log('右栏元素位置:', after);
} finally {
  await b.close();
}
console.log('\n截图目录:', OUT);
