/**
 * 干净环境下验证浅色主题（每次都新开标签页，避免状态残留）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10083;

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--disable-cache', `--remote-debugging-port=${PORT}`,
   '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-probe2', 'about:blank'],
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
    new Promise((resolve) => {
      const msgId = ++id;
      const handler = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === msgId) { ws.removeEventListener('message', handler); resolve(m.result); }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  // 先设好主题再导航，页面加载时就是浅色
  await send('Page.navigate', { url: BASE });
  await sleep(1000);
  await send('Runtime.evaluate', {
    expression: `localStorage.setItem('opencoxswain:theme','light')`,
  });
  await send('Page.navigate', { url: BASE + '?t=' + Date.now() });
  await sleep(1500);

  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const root = document.documentElement;
      const btn = document.querySelector('.btn--primary');
      const btnCs = btn ? getComputedStyle(btn) : null;
      return {
        theme: root.getAttribute('data-theme'),
        rootOnAction: getComputedStyle(root).getPropertyValue('--color-on-action').trim(),
        btnBg: btnCs?.backgroundColor,
        btnColor: btnCs?.color,
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
  ws.close();
} finally {
  chrome.kill();
}
