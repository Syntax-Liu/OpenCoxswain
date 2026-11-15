/**
 * 新界面截图（单独脚本，不依赖旧的 .ui-shots 结构）。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10201;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-new-shot',
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
  await send('Page.navigate', { url: `${BASE}?n=${Date.now()}` });
  await sleep(2200);

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`  ✓ ${name}.png`);
  };

  await shot('new-01-empty');

  // 报告一些实际尺寸信息
  const info = await send('Runtime.evaluate', {
    expression: `(() => {
      const de = document.documentElement;
      const head = document.querySelector('.head');
      const panel = document.querySelector('.panel');
      return {
        bodyHasPanel: document.querySelector('.body')?.className,
        headerText: head?.textContent?.trim().slice(0, 80),
        panelPresent: !!panel,
        scrollW: de.scrollWidth, clientW: de.clientWidth,
        titleCount: (document.body.innerText.match(/OpenCoxswain/g) ?? []).length,
      };
    })()`,
    returnByValue: true,
  });
  console.log('\n布局检查:', JSON.stringify(info.result.value, null, 2));

  ws.close();
} finally {
  chrome.kill();
}
