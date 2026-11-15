import { openBrowser } from './lib/browser.mjs';
const b = await openBrowser({ baseUrl: 'http://127.0.0.1:47910/', height: 1000 });
try {
  await b.goto('/', 3500);
  // 旧界面的 onboarding 已经在后端配置过 key，可能是前端没拿到状态
  // 直接进主界面：通过 localStorage 或跳过
  await b.evaluate(`localStorage.setItem('ocx.onboarded', '1')`);
  await b.goto('/', 3500);

  const info = await b.evaluate(`({
    classes: [...document.querySelectorAll('[class]')].slice(0, 8).map(e => e.className).filter(Boolean),
    hasSidebar: !!document.querySelector('.sidebar, .rail, .project-rail'),
    text: document.body.innerText.slice(0, 150),
  })`);
  console.log(JSON.stringify(info, null, 2));
  await b.screenshot('restored-02');
} finally { await b.close(); }
