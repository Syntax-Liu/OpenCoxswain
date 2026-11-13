/**
 * 全面体检：找出界面上所有不符合规范的地方。
 *
 * 不靠肉眼找，用计算样式和规范对照。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9990;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=' + process.env.TEMP + '\\ocx-audit', 'about:blank'],
  { stdio: 'ignore' });

try {
  let targets;
  for (let i = 0; i < 40; i += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; }
    catch { await sleep(250); }
  }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const send = (m, p = {}) => new Promise((res) => {
    const i = ++id;
    const h = (e) => { const x = JSON.parse(e.data); if (x.id === i) { ws.removeEventListener('message', h); res(x.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:47900/' });
  await sleep(7000);
  await ev(`[...document.querySelectorAll('.onboarding-dismiss')].forEach(b=>b.click())`);
  await sleep(300);
  await ev(`(() => { const p = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'advmath'); if (p) p.click(); })()`);
  await sleep(2500);

  const audit = await ev(`(() => {
    const issues = [];
    const seen = new Set();

    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      const cls = (typeof el.className === 'string' ? el.className : '').trim();
      const tag = el.tagName.toLowerCase();
      const key = tag + '.' + cls;
      if (seen.has(key)) continue;
      seen.add(key);

      // 1. 字号不在 4 档
      const fs = parseFloat(cs.fontSize);
      if (![11, 12, 13, 15].includes(fs)) {
        issues.push({ type: '字号', el: key, value: fs + 'px', expect: '11/12/13/15' });
      }

      // 2. 圆角不在 3 档
      const br = cs.borderTopLeftRadius;
      if (br !== '0px' && !['3px', '4px'].includes(br) && !br.includes('%')) {
        issues.push({ type: '圆角', el: key, value: br, expect: '0/3/4/50%' });
      }

      // 3. padding / margin 不在 4px 网格
      for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                          'marginTop', 'marginBottom', 'gap']) {
        const v = parseFloat(cs[prop]);
        if (Number.isNaN(v) || v === 0) continue;
        if (v % 2 !== 0) {
          issues.push({ type: prop, el: key, value: v + 'px', expect: '偶数（4px 网格）' });
          break;
        }
      }
    }
    return issues;
  })()`);

  console.log(`发现 ${audit.length} 处不符合规范\n`);

  // 按类型分组
  const byType = {};
  for (const i of audit) {
    byType[i.type] = byType[i.type] || [];
    byType[i.type].push(i);
  }

  for (const [type, list] of Object.entries(byType)) {
    console.log(`=== ${type}（${list.length} 处）===`);
    for (const i of list.slice(0, 12)) {
      console.log(`  ${i.el.slice(0, 42).padEnd(44)} ${i.value.padEnd(10)} 应为 ${i.expect}`);
    }
    if (list.length > 12) console.log(`  ...还有 ${list.length - 12} 处`);
    console.log('');
  }

  ws.close();
} finally { chrome.kill(); }
