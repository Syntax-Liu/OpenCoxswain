import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/' });
try {
  await b.goto('/', 3000);
  // Ctrl+K 打开命令面板 → 打开浏览器
  await b.press('k', 'KeyK', 75, 2);
  await b.waitForSelector('.palette');
  await b.fill('.palette-input', '浏览器');
  await new Promise((r) => setTimeout(r, 500));
  const items = await b.evaluate(`[...document.querySelectorAll('.palette-label')].map(e => e.textContent)`);
  console.log('命令面板结果:', JSON.stringify(items));
  await b.click('.palette-item');
  await new Promise((r) => setTimeout(r, 1500));

  console.log('侧边栏打开:', await b.exists('.sidebar'));
  console.log('地址栏:', JSON.stringify(await b.value('.sidebar-url-input')));

  // 打开本地服务
  await b.fill('.sidebar-url-input', 'http://127.0.0.1:47910/');
  await b.clickButton('打开');
  await new Promise((r) => setTimeout(r, 2500));

  console.log('iframe 出现:', await b.exists('.sidebar-frame'));
  console.log('iframe src:', JSON.stringify(await b.evaluate(`document.querySelector('.sidebar-frame')?.src`)));

  // 测危险协议
  await b.fill('.sidebar-url-input', 'javascript:alert(1)');
  await b.clickButton('打开');
  await new Promise((r) => setTimeout(r, 800));
  const after = await b.evaluate(`document.querySelector('.sidebar-frame')?.src ?? null`);
  console.log('javascript: 之后 iframe src（应仍是上一个合法地址）:', JSON.stringify(after));

  await b.screenshot('sidebar-browser');
  console.log('  ✓ sidebar-browser.png');
} finally { await b.close(); }
