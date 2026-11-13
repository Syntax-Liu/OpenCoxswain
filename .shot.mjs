/** 截对话区真实截图。 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const out = process.argv[2] ?? 'shot.png';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9930;

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
   '--user-data-dir=' + process.env.TEMP + '\\ocx-shot', 'about:blank'],
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
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:47900/' });
  await sleep(7000);

  await evalJs(`[...document.querySelectorAll('.onboarding-dismiss')].forEach(b=>b.click())`);
  await sleep(300);
  await evalJs(`(() => {
    const p = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'advmath');
    if (p) p.click();
  })()`);
  await sleep(3000);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(out, Buffer.from(shot.data, 'base64'), 'base64');
  console.log('已保存:', out);
  ws.close();
} finally {
  chrome.kill();
}
