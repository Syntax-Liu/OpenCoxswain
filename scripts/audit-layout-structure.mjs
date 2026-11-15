/**
 * 检查界面上的结构性问题：重复元素、溢出、遮挡。
 * 这些是对比度审计看不到的。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10114;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-struct',
  'about:blank',
], { stdio: 'ignore' });

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
  const send = (m, p = {}) => new Promise((res) => {
    const msgId = ++id;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === msgId) { ws.removeEventListener('message', h); res(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: msgId, method: m, params: p }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}?s=${Date.now()}` });
  await sleep(1800);

  const expr = `(() => {
    const problems = [];

    // 1) 同一区块内文字完全重复且相邻的标题
    const bar = document.querySelector('.title-bar') || document.querySelector('header');
    if (bar) {
      const texts = [...bar.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && el.textContent.trim())
        .map((el) => ({ t: el.textContent.trim(), cls: el.className }));
      const counts = {};
      for (const x of texts) counts[x.t] = (counts[x.t] || 0) + 1;
      for (const [t, n] of Object.entries(counts)) {
        if (n > 1) problems.push('标题栏重复文字: "' + t + '" ×' + n);
      }
      problems.push('标题栏内容: ' + texts.map((x) => '"' + x.t + '"(' + x.cls + ')').join(' | '));
    }

    // 2) 水平溢出
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 2) {
      problems.push('页面横向溢出: scrollWidth=' + de.scrollWidth + ' clientWidth=' + de.clientWidth);
    }

    // 3) 元素溢出其父容器
    for (const el of document.querySelectorAll('.main *, .sidebar *')) {
      const r = el.getBoundingClientRect();
      const p = el.parentElement?.getBoundingClientRect();
      if (!p) continue;
      if (r.width > 0 && r.right > p.right + 4 && getComputedStyle(el).position !== 'fixed') {
        const cls = (el.className || '').toString().slice(0, 30);
        problems.push('溢出父容器: .' + cls + ' right=' + Math.round(r.right) + ' > parent=' + Math.round(p.right));
        if (problems.length > 12) break;
      }
    }

    // 4) 浮层是否遮挡主要输入区
    const composer = document.querySelector('.composer-box, .composer');
    const overlay = document.querySelector('.onboarding, .welcome-overlay, [class*="overlay"]');
    if (composer && overlay) {
      const c = composer.getBoundingClientRect();
      const o = overlay.getBoundingClientRect();
      const cs = getComputedStyle(overlay);
      if (cs.display !== 'none' && o.bottom > c.top && o.top < c.bottom && o.width > 200) {
        problems.push('浮层遮挡输入区: overlay bottom=' + Math.round(o.bottom) + ' composer top=' + Math.round(c.top));
      }
    }

    return problems;
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const list = r.result?.value ?? [];
  console.log(`发现 ${list.length} 条结构性问题：`);
  for (const p of list) console.log('  • ' + p);

  ws.close();
} finally {
  chrome.kill();
}
