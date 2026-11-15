/**
 * 验证设置面板：能打开、能读到真实配置、Esc 能关。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10278;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-settings',
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
  await send('Page.navigate', { url: `${BASE}?s=${Date.now()}` });
  await sleep(2600);

  // 点设置按钮
  const opened = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[aria-label="设置"]');
      if (!btn) return 'NO BUTTON';
      btn.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  console.log('打开设置:', opened.result.value);
  await sleep(1200);

  const state = await send('Runtime.evaluate', {
    expression: `({
      visible: !!document.querySelector('.settings'),
      title: document.querySelector('.settings-title')?.textContent ?? null,
      hint: document.querySelector('.settings-hint')?.textContent ?? null,
      urlValue: document.querySelector('#set-url')?.value ?? null,
      modelValue: document.querySelector('#set-model')?.value ?? null,
      hasKeyField: !!document.querySelector('#set-key'),
    })`,
    returnByValue: true,
  });
  console.log('面板状态:', JSON.stringify(state.result.value, null, 2));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT, 'new-06-settings.png'), Buffer.from(r.data, 'base64'));
  console.log('  ✓ new-06-settings.png');

  // Esc 关闭
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  const closed = await send('Runtime.evaluate', {
    expression: `!document.querySelector('.settings')`,
    returnByValue: true,
  });
  console.log('Esc 关闭:', closed.result.value === true ? 'OK' : '失败');

  ws.close();
} finally {
  chrome.kill();
}
