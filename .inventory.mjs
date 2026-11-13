/** 盘点对话区所有控件的真实尺寸。 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9920;

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
   '--user-data-dir=' + process.env.TEMP + '\\ocx-inv', 'about:blank'],
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
    new Promise((resolve) => {
      const msgId = ++id;
      const handler = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === msgId) { ws.removeEventListener('message', handler); resolve(m.result); }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:47900/' });
  await sleep(7000);

  await evalJs(`[...document.querySelectorAll('.onboarding-dismiss')].forEach(b=>b.click())`);
  await sleep(300);
  await evalJs(`(() => {
    const p = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'advmath');
    if (p) p.click();
  })()`);
  await sleep(2500);

  // 抓对话区所有可见控件的关键尺寸
  const inv = await evalJs(`(() => {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('main *, .composer *, .messages *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;

      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      const key = el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\\s+/).join('.') : '');
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        key,
        w: Math.round(r.width),
        h: Math.round(r.height),
        radius: cs.borderRadius,
        padding: cs.padding,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        border: cs.borderWidth + ' ' + cs.borderStyle,
        bg: cs.backgroundColor,
        gap: cs.gap,
        color: cs.color,
      });
    }
    return rows;
  })()`);

  console.log(`可见控件类: ${inv.length} 个\n`);
  console.log('KEY'.padEnd(44) + 'W×H'.padEnd(12) + 'RADIUS'.padEnd(14) + 'PADDING'.padEnd(22) + 'FONT');
  console.log('-'.repeat(110));
  for (const r of inv) {
    console.log(
      r.key.slice(0, 42).padEnd(44) +
      `${r.w}×${r.h}`.padEnd(12) +
      String(r.radius).slice(0, 12).padEnd(14) +
      String(r.padding).slice(0, 20).padEnd(22) +
      String(r.fontSize).slice(0, 8),
    );
  }

  await writeFile('inventory.json', JSON.stringify(inv, null, 2), 'utf8');
  console.log('\n已保存 inventory.json');
  ws.close();
} finally {
  chrome.kill();
}
