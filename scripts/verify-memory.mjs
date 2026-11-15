/**
 * 验证记忆分区：能选中项目、能读到候选与已生效记忆。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10312;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-memory',
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${BASE}?m=${Date.now()}` });
  await sleep(3000);

  // 打开设置
  await send('Runtime.evaluate', {
    expression: `document.querySelector('button[aria-label="设置"]')?.click()`,
  });
  await sleep(1200);

  // 滚到记忆分区
  const state = await send('Runtime.evaluate', {
    expression: `(() => {
      const sel = document.querySelector('#set-memory-project');
      if (!sel) return { found: false };
      // 选中当前项目
      if (sel.value) {
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const sections = [...document.querySelectorAll('.settings-section-title')].map((e) => e.textContent);
      return {
        found: true,
        options: [...sel.options].map((o) => o.textContent),
        value: sel.value,
        sections,
      };
    })()`,
    returnByValue: true,
  });
  console.log('记忆分区:', JSON.stringify(state.result.value, null, 2));

  await sleep(2000);

  // 滚到底部截图
  await send('Runtime.evaluate', {
    expression: `document.querySelector('.settings-body').scrollTop = 99999`,
  });
  await sleep(500);

  const mem = await send('Runtime.evaluate', {
    expression: `(() => ({
      items: document.querySelectorAll('.memory-item').length,
      labels: [...document.querySelectorAll('.settings-label')].map((e) => e.textContent),
      hints: [...document.querySelectorAll('.settings-hint')].map((e) => e.textContent.slice(0, 40)),
    }))()`,
    returnByValue: true,
  });
  console.log('记忆内容:', JSON.stringify(mem.result.value, null, 2));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT, 'new-10-memory.png'), Buffer.from(r.data, 'base64'));
  console.log('  ✓ new-10-memory.png');

  ws.close();
} finally {
  chrome.kill();
}
