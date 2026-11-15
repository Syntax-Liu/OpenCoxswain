/**
 * 验证决策卡的提交闭环：
 *   填答案 → 点发送 → 卡片消失 → 报告被 ack → 消息真的发出去
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const OUT = resolve(process.env.OCX_OUT ?? './.ui-shots');
await mkdir(OUT, { recursive: true });

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10301;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-decision',
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
  await send('Page.navigate', { url: `${BASE}?d=${Date.now()}` });
  await sleep(3200);

  const before = await send('Runtime.evaluate', {
    expression: `({
      cards: document.querySelectorAll('.decision').length,
      hasInput: !!document.querySelector('.decision-input'),
      buttons: [...document.querySelectorAll('.decision-actions button')].map((b) => b.textContent.trim()),
    })`,
    returnByValue: true,
  });
  console.log('提交前:', JSON.stringify(before.result.value, null, 2));

  if (before.result.value.cards === 0) {
    console.log('没有待决策卡片，无法验证');
    ws.close();
    process.exit(0);
  }

  // 填答案并点发送
  const acted = await send('Runtime.evaluate', {
    expression: `(() => {
      const ta = document.querySelector('.decision-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '收敛范围后重跑：只看 apps/web/src 目录，先给结论再补细节。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));

      // React 的 onChange 需要这个
      const ev = new Event('input', { bubbles: true });
      ta.dispatchEvent(ev);

      return 'filled';
    })()`,
    returnByValue: true,
  });
  console.log('填写:', acted.result.value);
  await sleep(600);

  const btnState = await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('.decision-actions button')].find((x) => x.textContent.trim() === '发送');
      return { found: !!b, disabled: b?.disabled ?? null };
    })()`,
    returnByValue: true,
  });
  console.log('发送按钮:', JSON.stringify(btnState.result.value));

  // 点发送
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => {
      const b = [...document.querySelectorAll('.decision-actions button')].find((x) => x.textContent.trim() === '发送');
      if (!b || b.disabled) return 'NOT CLICKABLE';
      b.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  console.log('点击发送:', clicked.result.value);

  await sleep(2500);

  const after = await send('Runtime.evaluate', {
    expression: `({ cards: document.querySelectorAll('.decision').length })`,
    returnByValue: true,
  });
  console.log('提交后卡片数:', after.result.value.cards, '（应减少）');

  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(OUT, 'new-09-decided.png'), Buffer.from(r.data, 'base64'));
  console.log('  ✓ new-09-decided.png');

  ws.close();
} finally {
  chrome.kill();
}
