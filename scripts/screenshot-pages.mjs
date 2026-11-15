/**
 * 逐页截图：深色 + 浅色两套主题，覆盖主要界面。
 *
 * 难点：首屏是「填 API Key」的引导页，没有 Key 进不去主界面。
 * 做法：直接往 localStorage 写入一个假 Key，让界面认为已配置，
 * 然后逐页导航截图。这不影响真实功能，只用于视觉核对。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT_DIR = resolve(process.env.OCX_OUT ?? './.ui-shots');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10091;

await mkdir(OUT_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
   '--window-size=1440,900',
   '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-shots', 'about:blank'],
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

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = resolve(OUT_DIR, `${name}.png`);
    await writeFile(file, Buffer.from(r.data, 'base64'));
    console.log(`  ✓ ${name}.png`);
  };

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  // 首次加载，写入种子状态
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await evaluate(`
    localStorage.setItem('opencoxswain:theme', 'dark');
    localStorage.setItem('opencoxswain:onboarded', '1');
    true
  `);

  for (const theme of ['dark', 'light']) {
    console.log(`\n[${theme}]`);
    await send('Page.navigate', { url: `${BASE}?t=${Date.now()}` });
    await sleep(1500);
    await evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
    await sleep(500);

    // 1) 首屏（可能是引导页或欢迎页）
    await shot(`${theme}-01-home`);

    // 2) 打开命令面板（Ctrl+K）
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 });
    await sleep(700);
    await shot(`${theme}-02-command-palette`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);

    // 3) 设置页（Ctrl+,）
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ',', code: 'Comma', modifiers: 2, windowsVirtualKeyCode: 188 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ',', code: 'Comma', modifiers: 2, windowsVirtualKeyCode: 188 });
    await sleep(900);
    await shot(`${theme}-03-settings`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  }

  ws.close();
  console.log(`\n输出目录: ${OUT_DIR}`);
} finally {
  chrome.kill();
}
