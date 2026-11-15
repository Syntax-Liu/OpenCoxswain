/**
 * 截图：方案横条。
 */
import { openBrowser } from './lib/browser.mjs';

const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/' });
try {
  await b.goto('/', 3200);

  const has = await b.exists('.plan-banner');
  console.log('方案横条存在:', has);

  if (has) {
    const text = await b.text('.plan-banner-head');
    console.log('横条文字:', JSON.stringify(text));

    // 展开
    await b.click('.plan-banner-head');
    await new Promise((r) => setTimeout(r, 600));

    const detail = await b.evaluate(`({
      steps: document.querySelectorAll('.plan-step').length,
      goal: document.querySelector('.plan-goal')?.textContent?.slice(0, 60),
      statuses: [...document.querySelectorAll('.plan-step')].map((s) => s.className.replace('plan-step ', '')),
      buttons: [...document.querySelectorAll('.plan-actions button')].map((x) => x.textContent.trim()),
      hint: document.querySelector('.plan-hint')?.textContent?.slice(0, 40),
    })`);
    console.log('详情:', JSON.stringify(detail, null, 2));
  }

  await b.screenshot('plan-01-banner');
  console.log('  ✓ plan-01-banner.png');

  await b.evaluate(`document.querySelector('.plan-banner-head')?.click()`);
  await new Promise((r) => setTimeout(r, 500));
} finally {
  await b.close();
}
