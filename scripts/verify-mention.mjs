/**
 * 验证 @ 引用补全。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47900/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 10267;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  '--window-size=1440,900',
  '--user-data-dir=' + (process.env.TEMP ?? '.') + '\\ocx-mention', 'about:blank',
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
  await send('Page.navigate', { url: `${BASE}?m=${Date.now()}` });
  await sleep(2600);

  // 在输入框里打 "@comp"
  const typed = await send('Runtime.evaluate', {
    expression: `(() => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return 'NO TEXTAREA';
      // React 受控组件需要走原生 setter + input 事件
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '@comp');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(5, 5);
      return 'typed';
    })()`,
    returnByValue: true,
  });
  console.log('输入:', typed.result.value);

  await sleep(1200);

  const state = await send('Runtime.evaluate', {
    expression: `({
      mentionVisible: !!document.querySelector('.mention'),
      items: [...document.querySelectorAll('.mention-item')].map((b) => b.textContent.trim()),
    })`,
    returnByValue: true,
  });
  console.log('补全状态:', JSON.stringify(state.result.value, null, 2));

  // 点击第一项
  if ((state.result.value?.items ?? []).length > 0) {
    const picked = await send('Runtime.evaluate', {
      expression: `(() => {
        const b = document.querySelector('.mention-item');
        b.click();
        return 'clicked';
      })()`,
      returnByValue: true,
    });
    await sleep(400);
    const after = await send('Runtime.evaluate', {
      expression: `document.querySelector('.composer textarea').value`,
      returnByValue: true,
    });
    console.log('选中后输入框内容:', JSON.stringify(after.result.value));
  }

  ws.close();
} finally {
  chrome.kill();
}
