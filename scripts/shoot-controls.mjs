/**
 * 控件图鉴：把每个控件的全部变体与状态渲染成一张图，供文档使用。
 *
 * ## 为什么不用应用截图
 *
 * 应用里一个控件只出现在某个具体场景，看不到"全部状态"。
 * 写文档需要的是**对照表式**的图：同一个控件的 default / hover /
 * active / disabled / loading 排在一起。
 *
 * 做法：往真实页面里注入一个 fixture 容器，用**真实的类名**，
 * 这样渲染出来的就是产品里真正的样子（含主题、字号缩放）。
 *
 * 产出：`docs/assets/controls/*.png`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openBrowser } from './lib/browser.mjs';

const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47950';
const health = await fetch(`${BASE}/api/health`, {
  headers: { authorization: `Bearer ${process.env.OPENCOXSWAIN_TOKEN ?? 'audit-token-123'}` },
}).catch(() => null);
if (!health?.ok) throw new Error(`审计服务没起来（${BASE}）`);

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'assets', 'controls');
mkdirSync(OUT, { recursive: true });

const b = await openBrowser({ baseUrl: BASE, width: 1100, height: 900 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每张图：标题 + 说明 + 该控件的一组示例。 */
const PANELS = [
  {
    id: 'button',
    title: 'Button',
    note: '三档尺寸 × 三种变体。primary 一屏只有一个。',
    body: `
      <div class="fx-row">
        <button class="btn btn--primary btn--sm">sm</button>
        <button class="btn btn--primary btn--md">md</button>
        <button class="btn btn--primary btn--lg">lg</button>
      </div>
      <div class="fx-row">
        <button class="btn btn--secondary btn--md">secondary</button>
        <button class="btn btn--ghost btn--md">ghost</button>
        <button class="btn btn--danger btn--md">danger</button>
        <button class="btn btn--link btn--md">link</button>
      </div>
      <div class="fx-row">
        <button class="btn btn--primary btn--md" disabled>disabled</button>
        <button class="btn btn--secondary btn--md" disabled>disabled</button>
        <button class="btn btn--primary btn--md" data-loading="true">loading</button>
      </div>
      <div class="fx-row">
        <button class="btn btn--primary btn--md btn--pill">胶囊 26px 高</button>
        <button class="btn btn--secondary btn--lg btn--pill">胶囊 32px 高</button>
      </div>
      <div class="fx-row">
        <button class="btn btn--ghost btn--sm btn--icon" aria-label="关闭">✕</button>
        <button class="btn btn--ghost btn--icon-md" aria-label="关闭">✕</button>
        <button class="btn btn--secondary btn--sm btn--icon" aria-label="加">+</button>
      </div>`,
  },
  {
    id: 'list-item',
    title: 'ListItem',
    note: '整行可点。三档密度，选中态带左侧强调条。',
    body: `
      <div class="fx-col" style="width:260px">
        <button class="list-item list-item--compact"><span>compact · 22px</span></button>
        <button class="list-item"><span>normal · 26px</span></button>
        <button class="list-item list-item--roomy"><span>roomy · 32px</span></button>
        <button class="list-item is-selected"><span>selected</span></button>
        <button class="list-item" disabled><span>disabled</span></button>
      </div>`,
  },
  {
    id: 'option-item',
    title: 'OptionItem',
    note: '必须表达"选中了哪一项"，selected 同步到 aria-selected。',
    body: `
      <div class="fx-col" style="width:300px">
        <button class="option-item rail-tab">页签 · 未选中</button>
        <button class="option-item rail-tab active" aria-selected="true">页签 · 选中</button>
        <button class="option-item ui-select-item">下拉选项</button>
        <button class="option-item template-card">卡片型选项</button>
      </div>`,
  },
  {
    id: 'input',
    title: 'TextInput / Textarea / Field',
    note: '输入控件与 Button 同高同圆角。焦点是边框亮起，不是外轮廓。',
    body: `
      <div class="fx-col" style="width:340px">
        <input class="input" placeholder="默认 26px 高" />
        <input class="input input--sm" placeholder="小号 22px 高" />
        <input class="input" value="有内容" />
        <input class="input" placeholder="禁用" disabled />
        <input class="input" placeholder="报错态" aria-invalid="true" />
        <textarea class="input" rows="2" placeholder="多行输入"></textarea>
        <div class="field">
          <label class="field-label">带标签的字段<span class="field-required">*</span></label>
          <input class="input" placeholder="填写" />
          <p class="field-msg">这是一句说明文字</p>
        </div>
        <div class="field field--error">
          <label class="field-label">报错字段</label>
          <input class="input" value="错误值" />
          <p class="field-msg">这里显示错误原因</p>
        </div>
      </div>`,
  },
  {
    id: 'send',
    title: 'SendButton',
    note: '正圆 34×34。形状是与 Button 的刻意差异。',
    body: `
      <div class="fx-row">
        <button class="send-btn" aria-label="发送">↑</button>
        <button class="send-btn" aria-label="发送" disabled>↑</button>
      </div>`,
  },
];

/**
 * 注入 fixture（用真实类名，应用样式会作用上去）。
 *
 * HTML 内容用 JSON.stringify 传进去，避免模板字符串里
 * 反引号/引号层层转义出错（第一次写就是这么炸的）。
 */
function buildFixture(panel) {
  const payload = JSON.stringify({ title: panel.title, note: panel.note, body: panel.body });
  return `(() => {
    document.querySelectorAll('#__gallery__').forEach((n) => n.remove());
    const data = ${payload};
    const host = document.createElement('div');
    host.id = '__gallery__';
    host.style.cssText = 'position:fixed;inset:0;z-index:99998;background:var(--color-surface-canvas);padding:32px 40px;overflow:auto;font-family:inherit;';
    host.innerHTML =
      '<h1 style="margin:0 0 6px;font-size:20px;color:var(--color-label-strong);font-weight:600">' + data.title + '</h1>' +
      '<p style="margin:0 0 24px;font-size:13px;color:var(--color-label-tertiary)">' + data.note + '</p>' +
      '<div style="display:flex;flex-direction:column;gap:18px">' + data.body + '</div>';
    document.body.appendChild(host);
    const style = document.createElement('style');
    style.textContent =
      '.fx-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      '.fx-col{display:flex;flex-direction:column;gap:8px}' +
      '.fx-col .list-item,.fx-col .option-item{text-align:left}';
    host.appendChild(style);
    return true;
  })()`;
}

try {
  await b.goto('/');
  await sleep(1600);

  for (const theme of ['dark', 'light']) {
    await b.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
    await sleep(300);
    for (const panel of PANELS) {
      await b.evaluate(buildFixture(panel));
      await sleep(400);
      const file = await b.screenshot(`${theme}-${panel.id}`, OUT);
      console.log(`  ${file}`);
    }
  }
  // 清掉 fixture
  await b.evaluate(`document.querySelectorAll('#__gallery__').forEach((n) => n.remove()); true`);
} finally {
  await b.close();
}

console.log(`\n共 ${PANELS.length * 2} 张，输出到 ${OUT}`);
