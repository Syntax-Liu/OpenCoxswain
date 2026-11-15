import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 3500);

  // 拦截 fetch，记录 say 请求的实际 body
  await b.evaluate(`
    window.__sayBodies = [];
    const orig = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/say') && init?.body) {
        try { window.__sayBodies.push(JSON.parse(init.body)); } catch {}
      }
      return orig(input, init);
    };
    'patched';
  `);

  // 构造一张图塞进输入区（模拟拖入）
  const added = await b.evaluate(`(async () => {
    // 造一个 1x1 PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 'test.png', { type: 'image/png' });

    const input = document.querySelector('input[type=file]');
    if (!input) return 'no file input';
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'added';
  })()`);
  console.log('加图:', added);
  await new Promise((r) => setTimeout(r, 1500));

  const strip = await b.evaluate(`({
    strip: document.querySelectorAll('.attachment-chip, .attachment, [class*=attach]').length,
    html: document.querySelector('.composer, .chat-composer')?.innerHTML?.slice(0, 200) ?? 'no composer',
  })`);
  console.log('附件区:', JSON.stringify(strip).slice(0, 300));

  // 发送
  await b.fill('textarea', '测试图片');
  await b.press('Enter', 'Enter', 13);
  await new Promise((r) => setTimeout(r, 2500));

  const bodies = await b.evaluate(`window.__sayBodies`);
  console.log('say 请求体:', JSON.stringify(bodies).slice(0, 400));
} finally { await b.close(); }
