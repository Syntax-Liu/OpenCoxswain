import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 900 });
try {
  await b.goto('/', 3500);
  const r = await b.evaluate(`(() => {
    const bar = document.querySelector('.title-bar');
    const actions = document.querySelector('.title-bar-actions');
    if (!bar) return { error: 'no title-bar' };
    const barRect = bar.getBoundingClientRect();
    const actRect = actions?.getBoundingClientRect();
    return {
      barWidth: Math.round(barRect.width),
      hasActions: !!actions,
      actionsRight: actRect ? Math.round(actRect.right) : null,
      barRight: Math.round(barRect.right),
      isOnRight: actRect ? (barRect.right - actRect.right) < 20 : null,
      hasSpacer: !!document.querySelector('.title-bar-spacer'),
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
} finally { await b.close(); }
