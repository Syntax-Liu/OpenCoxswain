/**
 * ListItem 现状测量：先探活，再量。
 *
 * 教训（ui-dev-guide 7.7）：测量工具挂了会静默通过。
 * 所以第一件事是 /api/health 探活，失败直接抛错；
 * 量不到数据也抛错，不当"正常"。
 */
import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';

const health = await fetch(`${BASE}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPENCOXSWAIN_TOKEN ?? 'audit-token-123'}` },
}).catch(() => null);
if (!health?.ok) throw new Error(`审计服务没起来（${BASE}），先启动再跑。`);

/** 注入会话行，覆盖 thread-item 场景。 */
const SEED = String.raw`(() => {
  const list = document.querySelector('.thread-list');
  if (!list) return 'no-thread-list';
  list.insertAdjacentHTML('afterbegin',
    '<button class="list-item thread-item">' +
      '<span class="thread-title">登录页重构这件事很长很长很长很长</span>' +
      '<span class="thread-status">已完成</span>' +
    '</button>' +
    '<button class="list-item thread-item is-selected">' +
      '<span class="thread-title">导出卡住</span>' +
      '<span class="thread-status">进行中</span>' +
    '</button>');
  return 'ok';
})()`;

const MEASURE = String.raw`(() => {
  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('.list-item')) {
    const cls = [...el.classList].filter(
      (c) => c !== 'list-item' && !c.startsWith('list-item--') && c !== 'is-selected',
    );
    const key = cls.join('.') || '(无场景类)';
    if (seen.has(key)) continue;
    seen.add(key);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push({
      scenario: key,
      h: Math.round(r.height),
      pad: cs.padding,
      radius: cs.borderRadius,
      fontSize: cs.fontSize,
      lineHeight: cs.lineHeight,
      text: (el.textContent || '').trim().slice(0, 12),
    });
  }
  return rows;
})()`;

const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await b.goto('/');
  await sleep(1800);
  await b.evaluate(`document.querySelector('.project-folder')?.click(); true`);
  await sleep(1500);

  const seeded = await b.evaluate(SEED);
  if (seeded !== 'ok') console.log(`  注入失败：${seeded}（只量现有场景）`);
  await sleep(400);

  const out = await b.evaluate(MEASURE);
  if (!Array.isArray(out) || out.length === 0) {
    throw new Error('ListItem 测量返回空——不要当成功');
  }

  console.log(`共 ${out.length} 种 ListItem 场景\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad('场景', 30), pad('高', 5), pad('padding', 22), pad('圆角', 8), pad('字号', 10), '行高',
  );
  console.log('-'.repeat(92));
  for (const r of out) {
    console.log(
      pad(r.scenario, 30), pad(r.h, 5), pad(r.pad, 22), pad(r.radius, 8), pad(r.fontSize, 10), r.lineHeight,
    );
  }
} finally {
  await b.close();
}
