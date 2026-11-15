import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 3500);
  await b.screenshot('now-01-default');
  console.log('  ✓ 默认视图');
} finally { await b.close(); }
