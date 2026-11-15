import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 1000 });
try {
  await b.goto('/', 4000);
  const info = await b.evaluate(`({
    hasOldLayout: !!document.querySelector('.app'),
    hasRailToggle: !!document.querySelector('.rail-toggle'),
    hasSidebar: !!document.querySelector('.sidebar'),
    hasPlanBanner: !!document.querySelector('.plan-banner'),
    hasFileCard: !!document.querySelector('.file-card'),
    bodyText: document.body.innerText.slice(0, 120),
  })`);
  console.log(JSON.stringify(info, null, 2));
  await b.screenshot('restored-01');
  console.log('  ✓ restored-01.png');
} finally { await b.close(); }
