/**
 * 验证命令面板：Ctrl+K 打开、能搜到项目、能执行。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10289;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-palette',
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
  await send('Page.navigate', { url: `${BASE}?p=${Date.now()}` });
  await sleep(2600);

  // Ctrl+K
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
  await sleep(600);

  const state = await send('Runtime.evaluate', {
    expression: `({
      visible: !!document.querySelector('.palette'),
      focused: document.activeElement?.className ?? null,
      items: [...document.querySelectorAll('.palette-item')].map(
        (b) => b.querySelector('.palette-group')?.textContent + ':' + b.querySelector('.palette-label')?.textContent
      ),
    })`,
    returnByValue: true,
  });
  console.log('面板:', JSON.stringify(state.result.value, null, 2));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT, 'new-07-palette.png'), Buffer.from(r.data, 'base64'));
  console.log('  ✓ new-07-palette.png');

  // 搜索
  const searched = await send('Runtime.evaluate', {
    expression: `(() => {
      const inp = document.querySelector('.palette-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '设置');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`,
    returnByValue: true,
  });
  await sleep(400);
  const filtered = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('.palette-label')].map((e) => e.textContent)`,
    returnByValue: true,
  });
  console.log('搜索「设置」结果:', JSON.stringify(filtered.result.value));

  ws.close();
} finally {
  chrome.kill();
}
