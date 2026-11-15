import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/' });
try {
  await b.goto('/', 3500);
  const cards = await b.count('.file-card');
  console.log('文件卡片数:', cards);
  if (cards > 0) {
    console.log('第一张:', JSON.stringify(await b.text('.file-card')));
    const hasPreview = await b.exists('.file-card-preview');
    console.log('有预览按钮:', hasPreview);
    if (hasPreview) {
      await b.click('.file-card-preview');
      await new Promise((r) => setTimeout(r, 1500));
      console.log('侧边栏打开:', await b.exists('.sidebar'));
      console.log('侧边栏标题:', JSON.stringify(await b.text('.sidebar-title')));
      console.log('代码内容长度:', await b.evaluate(`document.querySelector('.sidebar-code')?.textContent?.length ?? 0`));
    }
  }
  await b.screenshot('file-card-01');
  console.log('  ✓ file-card-01.png');
} finally { await b.close(); }
