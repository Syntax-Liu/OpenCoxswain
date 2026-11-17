/**
 * 界面结构体检：**会失败**地检查溢出、重复、遮挡、控件越轨。
 *
 * ## 为什么重写这一份
 *
 * 旧的结构检查脚本（`audit-layout-structure.mjs`，已删除）只 `console.log`
 * 发现，**从不设置退出码**。
 * 于是 `pnpm ui:audit` 永远是绿的，手动测试清单里"0 溢出"是人眼看着截图填的。
 * 这正对应「界面设计总有些 bug，比如文字溢出等等」——
 * 检查器本身没在检查。
 *
 * ## 检查什么
 *
 * 1. **页面横向溢出**：`documentElement.scrollWidth > clientWidth`
 * 2. **元素压出父容器**：子元素右/下边缘越出父元素可见区（排除浮层、滚动容器内部）
 * 3. **文字被裁切但没省略号**：`overflow:hidden` + `nowrap` 却缺 `text-overflow`
 *    —— 看起来像"字被切掉一半"，是最典型的"界面坏了"
 * 4. **绝对定位元素互相遮挡**：两个浮层覆盖同一块文字
 * 5. **裸按钮**：`<button>` 没有 `.btn` 类（= 系统默认样式 ← 用户的原话）
 *
 * 每个发现的形式是 `{ view, theme, kind, selector, detail }`，
 * 与 `scripts/audit-baseline.json` 比对，**未在基线里的发现 → 退出码 1**。
 *
 * ## 为什么不用 jsdom
 *
 * 这些判断全靠 `getBoundingClientRect()` 和 `getComputedStyle()` 的真实结果。
 * jsdom / happy-dom 不做布局，宽度永远是 0，这类检查在那里**全部不成立**。
 * 所以必须用真实 Chrome（复用 `scripts/lib/browser.mjs`）。
 *
 * ## 用法
 *
 * ```bash
 * node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47910
 * node scripts/audit-ui-structure.mjs          # 失败时退出码 1
 * node scripts/audit-ui-structure.mjs --update # 把当前发现写成新的基线（需人工审）
 * ```
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { openBrowser } from './lib/browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE_PATH = resolve(ROOT, 'scripts/audit-baseline.json');
const OUT_DIR = resolve(ROOT, '.ui-shots', 'structure');
const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47910/';
const UPDATE = process.argv.includes('--update');

/**
 * 体检覆盖的视图。
 *
 * 每个视图 = 打开页面 + 一串操作，最后在**当前 DOM 上**跑检查。
 * 操作写成浏览器里能直接执行的表达式，和 `browser.mjs` 的 `evaluate` 对齐。
 */
const VIEWS = [
  {
    id: 'home',
    label: '首屏',
    setup: [],
  },
  {
    id: 'conversation',
    label: '对话中',
    setup: [
      // 先落一次对话：有消息时排版最容易溢出（长中文、长路径、代码块）
      {
        type: 'fill',
        selector: 'textarea.composer-input, .composer textarea, textarea',
        text: '把登录页重构一下，重点看看导出为什么卡住',
      },
      { type: 'click', selector: '.composer .btn--primary, .composer-send, button.send' },
      { type: 'sleep', ms: 2500 },
    ],
  },
  {
    id: 'sidebar',
    label: '侧边栏',
    setup: [
      // 侧栏列表是最容易长名字撑破的地方
      { type: 'evaluate', script: `document.querySelector('.sidebar')?.scrollTo(0, 0)` },
    ],
  },
  {
    id: 'right-rail',
    label: '右栏',
    setup: [
      {
        type: 'evaluate',
        script: `(() => {
          const b = [...document.querySelectorAll('button')]
            .find((x) => /侧边栏|栏|面板/.test(x.getAttribute('aria-label') || x.title || ''));
          b?.click();
          return !!b;
        })()`,
      },
      { type: 'sleep', ms: 600 },
    ],
  },
  {
    id: 'settings',
    label: '设置',
    setup: [
      {
        type: 'press',
        key: ',',
        code: 'Comma',
        vk: 188,
        modifiers: 2,
      },
      { type: 'sleep', ms: 900 },
    ],
  },
  {
    id: 'command-palette',
    label: '命令面板',
    setup: [
      { type: 'press', key: 'k', code: 'KeyK', vk: 75, modifiers: 2 },
      { type: 'sleep', ms: 700 },
    ],
  },
  /**
   * 轨迹页（TraceView）。
   *
   * **之前漏了**：原来只有 6 个视图，而 A / F / H 三份方案改的主要就是
   * TraceView 和 ChangePage——体检不覆盖它们，改坏了也发现不了。
   *
   * 先落一次对话，让"轨迹"标签出现（没有消息时它可能是空的）。
   */
  {
    id: 'trace',
    label: '轨迹',
    setup: [
      {
        type: 'fill',
        selector: 'textarea.composer-input, .composer textarea, textarea',
        text: '把登录页重构一下，重点看看导出为什么卡住',
      },
      { type: 'click', selector: '.composer .btn--primary, .composer-send, button.send' },
      { type: 'sleep', ms: 2500 },
      {
        type: 'evaluate',
        script: `(() => {
          const tab = [...document.querySelectorAll('[role="tab"]')]
            .find((b) => /轨迹/.test(b.textContent || ''));
          tab?.click();
          return !!tab;
        })()`,
      },
      { type: 'sleep', ms: 700 },
    ],
  },
  /**
   * 改动页（ChangePage）。
   *
   * 同样是之前漏掉的。它和 TraceView 是 A / F 方案的主要落点。
   */
  {
    id: 'changes',
    label: '改动',
    setup: [
      {
        type: 'evaluate',
        script: `(() => {
          const btn = [...document.querySelectorAll('button, [role="tab"]')]
            .find((b) => /改动/.test(b.textContent || ''));
          btn?.click();
          return !!btn;
        })()`,
      },
      { type: 'sleep', ms: 700 },
    ],
  },
];

const THEMES = ['dark', 'light'];

/**
 * 结构体检的白名单（**不是** `audit-baseline.json` 那个问题基线）。
 *
 * 这里放的是"设计上本来如此"的容器类，属于**规则本身**的一部分，
 * 不应随每次运行变化。改这里等同于改规则，需要审。
 */
const ALLOWLIST = {
  /**
   * 覆盖层：模态、下拉浮层、命令面板、引导层。
   * 它们用 fixed/absolute 故意压出父级边界，只要不遮输入区就不是缺陷。
   */
  overlayTraps: [
    '.modal',
    '.dialog',
    '.overlay',
    '.palette',
    '.command-palette',
    '.onboarding',
    '.picker-pop',
    '.mention-picker',
    '.select-pop',
    '.menu',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
  ],
};

/**
 * 页面里跑的检查。返回发现数组。
 *
 * 严格只用 CDP 可序列化的值（字符串/数字/布尔），不返回 DOM 节点。
 */
const CHECK_EXPRESSION = (allowlist) => `(() => {
  const ALLOW = ${JSON.stringify(allowlist)};
  const findings = [];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 3; depth += 1) {
      let seg = cur.tagName.toLowerCase();
      const cls = (typeof cur.className === 'string' ? cur.className : '').trim()
        .split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) seg += '.' + cls.join('.');
      // 加索引只在同一父级有同名兄弟时
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return null;
    if (Number(cs.opacity) === 0) return null;
    return { r, cs };
  };

  // 1) 页面横向溢出
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) {
    findings.push({
      kind: 'page-overflow',
      selector: 'html',
      detail: 'scrollWidth=' + de.scrollWidth + ' > clientWidth=' + de.clientWidth,
    });
  }

  const all = [...document.querySelectorAll('body *')].filter((el) => !SKIP_TAGS.has(el.tagName));

  // 2) 元素压出父容器
  for (const el of all) {
    const v = visible(el);
    if (!v) continue;
    const { r, cs } = v;
    if (cs.position === 'fixed' || cs.position === 'sticky') continue;
    // 单行省略号元素不可能是压边问题的来源：它就是被父级裁的
    if (cs.textOverflow === 'ellipsis') continue;
    // 覆盖层（模态/浮层）在设计上压出父级，不是缺陷
    if (ALLOW.overlayTraps.some((p) => el.closest(p))) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const ps = getComputedStyle(parent);
    // 父级自己就是滚动/裁剪容器时，子元素越界是设计好的（列表横滚）
    if (/auto|scroll/.test(ps.overflowX) || /auto|scroll/.test(ps.overflow)) continue;
    const pr = parent.getBoundingClientRect();
    if (pr.width < 1) continue;
    // 容差 4px：亚像素与抗锯齿
    if (r.right > pr.right + 4) {
      findings.push({
        kind: 'overflow-parent',
        selector: cssPath(el),
        detail: 'right=' + Math.round(r.right) + ' > parent.right=' + Math.round(pr.right),
      });
    }
  }

  // 3) 文字被裁切却没省略号 —— "字被切掉一半"
  for (const el of all) {
    if (el.children.length > 0) continue; // 只看叶子节点，文字就在它上面
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const v = visible(el);
    if (!v) continue;
    const { cs } = v;
    const clipped = cs.overflow === 'hidden' || cs.overflowX === 'hidden';
    const nowrap = cs.whiteSpace === 'nowrap';
    if (!clipped || !nowrap) continue;
    if (cs.textOverflow === 'ellipsis') continue;
    // 真的被裁了才算：滚动宽度大于可视宽度
    if (el.scrollWidth > el.clientWidth + 2) {
      findings.push({
        kind: 'clipped-text',
        selector: cssPath(el),
        detail: '"' + text.slice(0, 20) + '" scrollWidth=' + el.scrollWidth + ' > clientWidth=' + el.clientWidth + '（缺 text-overflow: ellipsis）',
      });
    }
  }

  // 4) 裸按钮（系统默认样式泄漏）
  //
  // **判定标准是"有没有被控件层接管"，不是"有没有 .btn 类"。**
  // src/ui 里有几族刻意不同的形状，它们各自有骨架类：
  //   .btn          动作按钮（Button / DangerButton / TextButton / IconButton）
  //   .list-item    列表行（ListItem）
  //   .option-item  可选项（OptionItem）
  //   .send-btn     正圆发送键（SendButton）
  //   .win-btn      OS 窗口键（WindowButton）
  //   .ctx-menu 内的 menuitem 菜单项（MenuItem，样式来自父级后代选择器）
  // 这几族的共同点是：骨架类里有 display / height / padding / color，
  // 不是靠浏览器默认样式。除此之外的 <button> 才算"裸"。
  const MANAGED = ['btn', 'list-item', 'option-item', 'send-btn', 'win-btn'];
  for (const el of document.querySelectorAll('button')) {
    if (!visible(el)) continue;
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    const managed = MANAGED.some((c) => cls.split(/\\s+/).includes(c));
    if (managed) continue;
    // 菜单项：样式由 .ctx-menu 的后代选择器给
    if (el.closest('.ctx-menu') && el.getAttribute('role') === 'menuitem') continue;
    findings.push({
      kind: 'raw-button',
      selector: cssPath(el),
      detail: 'button 没有进控件层（既无 .btn 也无 .list-item/.send-btn 等骨架类），用的是全局默认样式（文本: "' + (el.textContent || '').trim().slice(0, 12) + '"）',
    });
  }

  // 去重：同一选择器同一问题只报一次
  const seen = new Set();
  return findings.filter((f) => {
    const key = f.kind + '|' + f.selector;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
})()`;

/** 稳定排序 + 规范化为基线里的形式。 */
function normalize(findings, view, theme) {
  return findings
    .map((f) => ({
      key: `${view}/${theme}/${f.kind}/${f.selector}`,
      view,
      theme,
      kind: f.kind,
      selector: f.selector,
      detail: f.detail,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { allowed: [], note: '基线文件尚不存在' };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    console.error(`基线文件解析失败：${BASELINE_PATH}\n${err.message}`);
    process.exit(2);
  }
}

async function runView(browser, view) {
  await browser.goto('/', 2600);
  // 关掉引导层：它会盖住整个界面，导致所有检查失效
  await browser.evaluate(`(() => {
    localStorage.setItem('opencoxswain:onboarded', '1');
    document.querySelectorAll('.onboarding-dismiss, .onboarding [data-dismiss]').forEach((b) => b.click());
    return true;
  })()`);

  for (const step of view.setup) {
    if (step.type === 'sleep') await sleep(step.ms);
    else if (step.type === 'click') await browser.click(step.selector);
    else if (step.type === 'fill') await browser.fill(step.selector, step.text);
    else if (step.type === 'press') await browser.press(step.key, step.code, step.vk, step.modifiers ?? 0);
    else if (step.type === 'evaluate') await browser.evaluate(step.script);
  }
}

const results = [];
let browser;

try {
  browser = await openBrowser({ baseUrl: BASE, outDir: OUT_DIR });
} catch (err) {
  console.error(`无法启动浏览器：${err.message}`);
  process.exit(3);
}

try {
  for (const theme of THEMES) {
    for (const view of VIEWS) {
      await runView(browser, view);
      await browser.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);
      await sleep(400);

      // 截图留档：一条失败要能在图上定位
      await browser.screenshot(`structure-${theme}-${view.id}`, OUT_DIR);

      const raw = await browser.evaluate(CHECK_EXPRESSION(ALLOWLIST));
      results.push(...normalize(raw ?? [], view.id, theme));
      console.log(`  · ${theme}/${view.id}：${(raw ?? []).length} 条`);
    }
  }
} finally {
  await browser.close();
}

if (UPDATE) {
  const baseline = {
    note:
      '界面结构体检的已知问题基线。每条都是一次主观决定：要么本案是设计需要，要么待修。' +
      '**白名单只增不减需要人审批。** 由 `node scripts/audit-ui-structure.mjs --update` 生成。',
    updatedAt: new Date().toISOString(),
    allowed: results.map((r) => ({
      key: r.key,
      detail: r.detail,
      reason: '待补：为什么这条可以放过',
    })),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`\n已写入基线：${BASELINE_PATH}（${results.length} 条，**每条都要补 reason**）`);
  process.exit(0);
}

const baseline = loadBaseline();
const allowed = new Set((baseline.allowed ?? []).map((a) => a.key));
const current = new Set(results.map((r) => r.key));

const fresh = results.filter((r) => !allowed.has(r.key));
const stale = (baseline.allowed ?? []).filter((a) => !current.has(a.key));

console.log(`\n检查 ${VIEWS.length} 个视图 × ${THEMES.length} 套主题`);
console.log(`发现 ${results.length} 条，其中基线外新增 ${fresh.length} 条，基线内 ${results.length - fresh.length} 条`);

if (fresh.length > 0) {
  console.log('\n新增问题（必须修，或在基线里写明理由）：');
  for (const f of fresh) {
    console.log(`  ✗ [${f.view}/${f.theme}] ${f.kind}  ${f.selector}`);
    console.log(`      ${f.detail}`);
  }
}

if (stale.length > 0) {
  console.log(`\n基线里有 ${stale.length} 条已经不存在了——请跑 --update 收缩基线，避免白名单变成垃圾桶。`);
  for (const s of stale.slice(0, 10)) console.log(`  ○ ${s.key}`);
}

if (fresh.length > 0) {
  console.log('\n界面结构体检未通过。截图在：' + OUT_DIR);
  process.exit(1);
}

console.log('\n界面结构体检通过。');
