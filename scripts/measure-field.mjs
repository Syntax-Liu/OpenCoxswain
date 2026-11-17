/**
 * Field / TextInput 现状测量。
 *
 * 先探活（ui-dev-guide 7.7），量不到数据直接抛错。
 */
import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';
const health = await fetch(`${BASE}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPENCOXSWAIN_TOKEN ?? 'audit-token-123'}` },
}).catch(() => null);
if (!health?.ok) throw new Error(`审计服务没起来（${BASE}）`);

const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await b.goto('/');
  await sleep(1600);

  // 打开设置页：那里集中了各种输入框
  await b.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => /设置/.test(x.textContent || ''));
    btn?.click();
    return !!btn;
  })()`);
  await sleep(1400);

  const out = await b.evaluate(`(() => {
    const rows = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('input, textarea')) {
      const cls = String(el.className || '(无类)');
      const key = el.tagName + '.' + cls;
      if (seen.has(key)) continue;
      seen.add(key);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      rows.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.slice(0, 40),
        w: Math.round(r.width),
        h: Math.round(r.height),
        pad: cs.padding,
        radius: cs.borderRadius,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        border: cs.borderTopWidth + ' ' + cs.borderTopStyle,
        bg: cs.backgroundColor,
        outline: cs.outlineWidth + ' ' + cs.outlineStyle,
      });
    }
    return rows;
  })()`);

  if (!Array.isArray(out) || out.length === 0) throw new Error('量不到输入框——不要当成功');

  console.log(`共 ${out.length} 种输入控件\n`);
  for (const r of out) {
    console.log(`${r.tag}  ${r.cls}`);
    console.log(`   高 ${r.h}  内边距 ${r.pad}  圆角 ${r.radius}`);
    console.log(`   字号 ${r.fontSize}  行高 ${r.lineHeight}  边框 ${r.border}`);
    console.log(`   背景 ${r.bg}  焦点轮廓 ${r.outline}`);
    console.log('');
  }
} finally {
  await b.close();
}
