/**
 * 给 unslop 审计用：截当前界面的主要视图。
 *
 * 目的是"看真实画面"，而不是只看代码。
 */
import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';
const health = await fetch(`${BASE}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPENCOXSWAIN_TOKEN ?? 'audit-token-123'}` },
}).catch(() => null);
if (!health?.ok) throw new Error(`审计服务没起来（${BASE}）`);

const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 900 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await b.goto('/');
  await sleep(1800);
  await b.screenshot('unslop-01-home', '.ui-audit-shots');

  // 打开一个项目，看对话视图
  await b.evaluate(`document.querySelector('.project-folder')?.click(); true`);
  await sleep(1500);
  await b.screenshot('unslop-02-project', '.ui-audit-shots');

  // 设置页
  await b.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent || ''));
    btn?.click();
    return !!btn;
  })()`);
  await sleep(1500);
  await b.screenshot('unslop-03-settings', '.ui-audit-shots');

  console.log('已截 3 张');
} finally {
  await b.close();
}
