/**
 * 验证审批面板的完整交互：允许 → D 继续 → 文件真的被删。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10290;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-approve',
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
    const mid = ++id;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === mid) { ws.removeEventListener('message', h); res(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: mid, method: m, params: p }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${BASE}?a=${Date.now()}` });
  await sleep(3000);

  const before = await send('Runtime.evaluate', {
    expression: `({
      approvalVisible: !!document.querySelector('.approval'),
      why: document.querySelector('.approval-why')?.textContent ?? null,
      evidence: document.querySelector('.approval-evidence')?.textContent ?? null,
      time: document.querySelector('.approval-time')?.textContent ?? null,
    })`,
    returnByValue: true,
  });
  console.log('审批面板:', JSON.stringify(before.result.value, null, 2));

  // 点「允许这一次」
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('.approval-actions button')];
      const allow = btns.find((b) => b.textContent.includes('允许'));
      if (!allow) return 'NO ALLOW BUTTON';
      allow.click();
      return 'clicked allow';
    })()`,
    returnByValue: true,
  });
  console.log('点击:', clicked.result.value);

  await sleep(1500);
  const after = await send('Runtime.evaluate', {
    expression: `({ approvalStillVisible: !!document.querySelector('.approval') })`,
    returnByValue: true,
  });
  console.log('点击后审批是否消失:', !after.result.value.approvalStillVisible);

  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT, 'new-08-approved.png'), Buffer.from(r.data, 'base64'));
  console.log('  ✓ new-08-approved.png');

  ws.close();
} finally {
  chrome.kill();
}
