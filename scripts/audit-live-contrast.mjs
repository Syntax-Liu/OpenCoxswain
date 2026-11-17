/**
 * 在真实界面里找出对比度不足的元素。
 *
 * 静态审计只看令牌组合，看不到"实际用了哪个令牌在哪个背景上"。
 * 这里遍历页面上所有可见的文字元素，计算其前景/背景对比度。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10103;

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
   '--window-size=1440,900',
   '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-contrast', 'about:blank'],
  { stdio: 'ignore' },
);

try {
  let targets;
  for (let i = 0; i < 40; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch { await sleep(250); }
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolveP) => {
      const msgId = ++id;
      const handler = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === msgId) { ws.removeEventListener('message', handler); resolveP(m.result); }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const CONTRACT = `
  (() => {
    const parse = (s) => {
      const m = s.match(/rgba?\\(([^)]+)\\)/);
      if (!m) return null;
      const p = m[1].split(',').map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    };
    const lum = (c) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const over = (fg, bg) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const ratio = (a, b) => {
      const l1 = lum(a), l2 = lum(b);
      const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    /** 向上找第一个不透明的背景。 */
    const bgOf = (el) => {
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const c = parse(getComputedStyle(cur).backgroundColor);
        if (c && c.a > 0.9) return c;
        cur = cur.parentElement;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    };

    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      // 只取直接含文字的元素
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (!hasText) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.3) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > innerHeight) continue;

      const fg = parse(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const effective = fg.a < 1 ? over(fg, bg) : fg;
      const r = ratio(effective, bg);
      const size = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 600;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (r < need) {
        out.push({
          text: el.textContent.trim().slice(0, 28),
          cls: (el.className || '').toString().slice(0, 40),
          tag: el.tagName.toLowerCase(),
          color: cs.color,
          bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
          size: size,
          ratio: Math.round(r * 100) / 100,
          need,
        });
      }
    }
    // 去重（同样文字+颜色只报一次）
    const seen = new Set();
    return out.filter((o) => {
      const k = o.text + o.color + o.cls;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  })()
  `;

  let failed = false;

  for (const theme of ['dark', 'light']) {
    await send('Page.navigate', { url: `${BASE}?c=${Date.now()}` });
    await sleep(1600);
    await send('Runtime.evaluate', {
      expression: `localStorage.setItem('opencoxswain:theme','${theme}'); document.documentElement.setAttribute('data-theme','${theme}')`,
    });
    await sleep(600);

    const r = await send('Runtime.evaluate', { expression: CONTRACT, returnByValue: true });
    const list = r.result?.value ?? [];
    console.log(`\n═══ ${theme}：${list.length} 处文字对比度不足 ═══`);
    for (const o of list.slice(0, 20)) {
      console.log(
        `  ${String(o.ratio).padStart(5)}:1 (需 ${o.need})  "${o.text}"\n` +
        `         color=${o.color} bg=${o.bg} size=${o.size} class="${o.cls}"`,
      );
    }
    // 只打印不失败，等于这条检查没做。发现一处就非 0。
    if (list.length > 0) failed = true;
  }

  ws.close();
  if (failed) process.exitCode = 1;
} finally {
  chrome.kill();
}
