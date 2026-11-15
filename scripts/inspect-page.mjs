import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 4000);
  const s = await b.evaluate(`({
    text: document.body.innerText.slice(0, 300),
    inputs: document.querySelectorAll('input').length,
    editable: document.querySelectorAll('[contenteditable=true]').length,
  })`);
  console.log(JSON.stringify(s, null, 2));
  await b.screenshot('debug-current');
} finally { await b.close(); }
