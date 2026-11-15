/**
 * 截图：对话页 + 点开跑道的轨迹页。
 * 用真实数据，不做 mock。
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10256;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-trace-shot',
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
  await send('Page.navigate', { url: `${BASE}?t=${Date.now()}` });
  await sleep(2800);

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(resolve(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`  ✓ ${name}.png`);
  };

  // 1) 对话页
  await shot('new-03-chat');

  // 2) 点第一条跑道
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const lane = document.querySelector('.lane');
      if (!lane) return 'NO LANE';
      lane.click();
      return 'clicked: ' + lane.textContent.trim().slice(0, 40);
    })()`,
    returnByValue: true,
  });
  console.log('点击跑道:', clicked.result.value);

  await sleep(1800);
  await shot('new-04-trace');

  // 检查轨迹页是否渲染
  const state = await send('Runtime.evaluate', {
    expression: `({
      hasTrace: !!document.querySelector('.trace-head'),
      rows: document.querySelectorAll('.trace-row').length,
      title: document.querySelector('.trace-title')?.textContent ?? null,
      stats: document.querySelector('.trace-stats')?.textContent ?? null,
      empty: document.querySelector('.trace-empty')?.textContent ?? null,
    })`,
    returnByValue: true,
  });
  console.log('\n轨迹页状态:', JSON.stringify(state.result.value, null, 2));

  // 3) 展开第一条工具记录
  const expand = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = [...document.querySelectorAll('.trace-row-head')].filter((b) => !b.disabled);
      if (!btns.length) return 'NO EXPANDABLE';
      btns[0].click();
      return 'expanded: ' + btns[0].textContent.trim().slice(0, 30);
    })()`,
    returnByValue: true,
  });
  console.log('展开:', expand.result.value);
  await sleep(500);
  await shot('new-05-trace-detail');

  ws.close();
} finally {
  chrome.kill();
}
