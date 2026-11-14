/**
 * 按主题截图，用于人工核对两套主题的实际观感与对比度。
 *
 * 用法：
 *   node scripts/screenshot-theme.mjs dark  out-dark.png
 *   node scripts/screenshot-theme.mjs light out-light.png
 *
 * 主题通过 <html data-theme> 控制（见 apps/web/src/components/theme.ts）。
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const theme = process.argv[2] ?? 'dark';
const out = process.argv[3] ?? `shot-${theme}.png`;
const URL_TO_OPEN = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10061;

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-shot-theme',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  let targets;
  for (let i = 0; i < 40; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {
      await sleep(250);
    }
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
        if (m.id === msgId) {
          ws.removeEventListener('message', handler);
          resolve(m.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // 先注入主题到 localStorage，再导航，避免闪一下深色
  await send('Page.navigate', { url: URL_TO_OPEN });
  await sleep(1500);

  const applied = await send('Runtime.evaluate', {
    expression: `
      localStorage.setItem('opencoxswain:theme', ${JSON.stringify(theme)});
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
      document.documentElement.getAttribute('data-theme')
    `,
    returnByValue: true,
  });
  console.log(`data-theme = ${applied.result.value}`);
  await sleep(600);

  // 核对实际生效的背景色，确认主题真的切过去了
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        canvas: cs.getPropertyValue('--color-surface-canvas').trim(),
        label: cs.getPropertyValue('--color-label-primary').trim(),
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    })()`,
    returnByValue: true,
  });
  console.log('实际令牌：', JSON.stringify(probe.result.value));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log(`已保存: ${out}`);

  ws.close();
} finally {
  chrome.kill();
}
