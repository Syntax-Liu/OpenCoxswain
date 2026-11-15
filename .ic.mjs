import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 11330;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
   '--user-data-dir=' + process.env.TEMP + '\\ocx-ic', '--window-size=1600,1000', 'about:blank'],
  { stdio: 'ignore' });

try {
  let targets;
  for (let i = 0; i < 60; i += 1) {
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.length) break; }
    catch { /* 等 */ }
    await sleep(300);
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
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r?.result?.value;
  };

  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:47900/' });
  await sleep(9000);
  await ev(`[...document.querySelectorAll('.onboarding-dismiss')].forEach(b=>b.click())`);
  await sleep(800);

  // 1. 欢迎页图标
  const w = await ev(`(function () {
    var b = document.querySelector('.welcome-brand');
    if (!b) return { missing: true };
    var svg = b.querySelector('svg');
    var sp = b.querySelector('span[aria-hidden]');
    return {
      hasSvg: !!svg,
      themeAttr: svg ? svg.getAttribute('data-theme') : (sp && sp.querySelector('svg') ? sp.querySelector('svg').getAttribute('data-theme') : null),
      html: b.innerHTML.slice(0, 120)
    };
  })()`);
  console.log('欢迎页图标:', JSON.stringify(w));

  // 2. 打开设置 -> 通用 -> 找图标选择
  await ev(`(function(){
    var a=document.querySelectorAll('button');
    for(var i=0;i<a.length;i++) if(a[i].textContent.trim()==='设置'){a[i].click();return 1;}
    return 0;
  })()`);
  await sleep(2000);

  await ev(`(function(){
    var n=document.querySelectorAll('.settings-nav-item');
    for(var i=0;i<n.length;i++) if(n[i].textContent.indexOf('通用')>=0){n[i].click();return 1;}
    return 0;
  })()`);
  await sleep(1500);

  const opt = await ev(`(function () {
    var opts = document.querySelectorAll('.icon-theme-option');
    return {
      count: opts.length,
      labels: Array.from(opts).map(function(o){ return o.textContent.trim(); }),
      active: Array.from(opts).filter(function(o){ return o.classList.contains('is-active'); }).map(function(o){ return o.textContent.trim(); }),
      hasSvg: opts.length > 0 && !!opts[0].querySelector('svg')
    };
  })()`);
  console.log('图标选项:', JSON.stringify(opt));

  // 截图设置页
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${process.env.TEMP}\\ocx-icons-setting.png`, Buffer.from(shot1.data, 'base64'));

  // 3. 点「暖珊瑚」切换
  await ev(`(function(){
    var opts=document.querySelectorAll('.icon-theme-option');
    for(var i=0;i<opts.length;i++) if(opts[i].textContent.indexOf('暖珊瑚')>=0){opts[i].click();return 1;}
    return 0;
  })()`);
  await sleep(1000);

  const after = await ev(`(function () {
    var opts = document.querySelectorAll('.icon-theme-option');
    return {
      active: Array.from(opts).filter(function(o){ return o.classList.contains('is-active'); }).map(function(o){ return o.textContent.trim(); }),
      stored: localStorage.getItem('opencoxswain.iconTheme')
    };
  })()`);
  console.log('切换后:', JSON.stringify(after));

  // 4. 回欢迎页看图标有没有跟着变
  await ev(`(function(){ var b=document.querySelector('.settings-back, .back-btn'); if(b){b.click();return 1;} return 0; })()`);
  await sleep(500);
  await ev(`(function(){
    var a=document.querySelectorAll('button');
    for(var i=0;i<a.length;i++) if(a[i].textContent.trim().indexOf('返回应用')>=0){a[i].click();return 1;}
    return 0;
  })()`);
  await sleep(1500);

  const w2 = await ev(`(function () {
    var b = document.querySelector('.welcome-brand');
    if (!b) return { missing: true };
    var svg = b.querySelector('svg');
    return { theme: svg ? svg.getAttribute('data-theme') : null };
  })()`);
  console.log('切回后欢迎页:', JSON.stringify(w2));

  ws.close();
} finally { chrome.kill(); }
