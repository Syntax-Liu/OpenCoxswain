import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 3500);
  const s = await b.evaluate(`({
    textareas: document.querySelectorAll('textarea').length,
    fileInputs: document.querySelectorAll('input[type=file]').length,
    composerClasses: [...document.querySelectorAll('textarea')].map(t => t.closest('[class]')?.className),
    attachmentClasses: [...document.querySelectorAll('[class*=attach]')].map(e => e.className).slice(0,5),
  })`);
  console.log(JSON.stringify(s, null, 2));
} finally { await b.close(); }
