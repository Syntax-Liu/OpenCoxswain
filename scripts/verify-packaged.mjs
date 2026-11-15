import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 3500);
  const r = await b.evaluate(`({
    hasNavMain: !!document.querySelector('.nav-main'),
    hasSidebar: !!document.querySelector('.sidebar'),
    hasPlanBanner: !!document.querySelector('.plan-banner'),
    hasFileCard: !!document.querySelector('.file-card'),
    titleCount: (document.querySelector('.title-bar')?.innerText.match(/OpenCoxswain/g) ?? []).length,
  })`);
  console.log('打包版界面检查:', JSON.stringify(r, null, 2));
} finally { await b.close(); }
