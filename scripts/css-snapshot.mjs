/**
 * CSS 计算样式快照：改动前后的视觉等价性验证。
 *
 * ## 为什么需要
 *
 * 合并重复的 CSS 规则时，"看起来一样"不是证据。
 * CSS 是后定义覆盖先定义，一处合并错了肉眼完全看不出来。
 *
 * 所以：改之前存一份每个元素的计算样式，改之后逐条比对。
 * **任何一条不同就是视觉变化**，不管它看起来多不起眼。
 *
 * ## 用法
 *
 *   OCX_URL=http://127.0.0.1:47911 node scripts/css-snapshot.mjs before
 *   （改 CSS + pnpm build）
 *   OCX_URL=http://127.0.0.1:47911 node scripts/css-snapshot.mjs after
 *   node scripts/css-snapshot.mjs diff
 *
 * 快照存在 `.css-snapshot/`（已 gitignore）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { openBrowser } from './lib/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const DIR = join(ROOT, '.css-snapshot');
const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47911';
const phase = process.argv[2] ?? 'before';

/** 比对哪些属性：布局、排版、颜色、边框。 */
const PROPS = [
  'display', 'position', 'flex-direction', 'flex-wrap', 'justify-content',
  'align-items', 'gap', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-bottom-width', 'border-radius',
  'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'color', 'background-color', 'opacity', 'text-align', 'white-space',
  'overflow-x', 'overflow-y', 'text-overflow',
  'table-layout', 'border-collapse', 'grid-template-columns', 'z-index',
];

/**
 * 注入一棵**代表性 DOM**，覆盖那些首屏不出现、但样式复杂的类。
 *
 * 为什么不能只拍首页：首屏只有 96 个元素，没有 `.thread-item`、
 * 没有 `.md-body` 的完整结构。只靠首屏的话，改坏这些地方快照也发现不了
 * （我第一次跑就踩了这个坑：注入 `padding-left: 99px` 后仍然"零差异"）。
 */
const FIXTURE_FN = `(() => {
  const host = document.createElement('div');
  host.id = '__css_fixture__';
  host.style.cssText = 'position:absolute;left:0;top:0;width:1200px;';
  host.innerHTML = \`
    <nav class="sidebar">
      <div class="project-folder">
        <button class="folder-name-btn">一个很长的项目名字用来测截断</button>
        <div class="thread-list">
          <button class="thread-item"><span class="thread-title">登录页重构</span><span class="thread-status">2 分钟前</span></button>
          <button class="thread-item active"><span class="thread-title">导出卡住的问题</span></button>
          <button class="thread-item"><span class="thread-title">写测试</span></button>
        </div>
      </div>
    </nav>
    <div class="md-body">
      <h1>一级标题</h1><h2>二级标题</h2><h3>三级标题</h3><h4>四级标题</h4>
      <p>普通段落，包含<code>行内代码</code>和一些中文标点，测试行高与间距。</p>
      <p>第二个段落。</p>
      <ul><li>列表项一</li><li>列表项二</li></ul>
      <ol><li>有序一</li><li>有序二</li></ol>
      <blockquote><p>引用块</p></blockquote>
      <pre><code>const a = 1;
function b() { return a; }</code></pre>
      <table><thead><tr><th>列一</th><th>列二</th></tr></thead>
        <tbody><tr><td>值</td><td>值</td></tr><tr><td>值</td><td>值</td></tr></tbody></table>
    </div>
    <div class="batch-block">
      <div class="batch-line">
        <span class="batch-rule"></span>
        <span class="batch-meta"><span class="batch-time">03:14</span><span class="batch-summary">派出 2 个</span></span>
        <span class="batch-rule"></span>
      </div>
      <ul class="batch-tasks">
        <li><button class="list-item batch-task">
          <span class="batch-dot done"></span>
          <span class="batch-task-label">查依赖漏洞</span>
          <span class="batch-task-status">完成</span>
          <span class="batch-task-duration">0:51</span>
        </button></li>
      </ul>
    </div>
    <div class="composer">
      <div class="composer-box">
        <textarea class="composer-input">输入框里的文字</textarea>
        <div class="composer-actions">
          <button class="btn btn--primary btn--sm">发送</button>
          <button class="btn btn--secondary btn--sm">附件</button>
          <button class="btn btn--ghost btn--sm">更多</button>
          <button class="btn btn--danger btn--sm">删除</button>
          <button class="btn btn--link btn--sm">链接</button>
        </div>
      </div>
    </div>
    <div class="error-card tone-danger">
      <div class="error-card-head"><span class="error-card-kind">环境问题</span><span class="error-card-title">出错了</span></div>
      <p class="error-card-action">修一下环境</p>
      <p class="error-card-preserved"><span class="error-card-label">已保留</span>改动已保存</p>
      <div class="error-card-recovery"><button class="btn btn--secondary btn--sm">回滚</button></div>
    </div>
    <div class="effects">
      <div class="effects-head"><span class="muted small">改动了 2 项</span></div>
      <ul class="effects-list">
        <li class="succeeded"><span class="eff-kind">写入</span><code class="eff-target">src/a.ts</code><span class="eff-state">已生效</span></li>
      </ul>
    </div>
  \`;
  document.body.appendChild(host);
  return host.children.length;
})()`;

/** 注入页面执行：抓所有元素的计算样式。 */
const CAPTURE_FN = `(() => {
  const PROPS = ${JSON.stringify(PROPS)};
  const out = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (['SCRIPT','STYLE','META','LINK','HEAD','TITLE'].includes(el.tagName)) continue;
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of PROPS) style[p] = cs.getPropertyValue(p);
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    const parent = el.parentElement;
    const index = parent ? Array.prototype.indexOf.call(parent.children, el) : 0;
    out.push({
      key: el.tagName.toLowerCase() + '|' + cls + '|' + index + '|' + (parent ? parent.tagName : 'root'),
      style,
    });
  }
  return out;
})()`;

function compare(before, after) {
  const diffs = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!b || !a) {
      diffs.push({ key: (b ?? a).key, prop: '(元素缺失)', from: '', to: '' });
      continue;
    }
    if (b.key !== a.key) {
      diffs.push({ key: b.key, prop: '(元素顺序不同)', from: b.key, to: a.key });
      continue;
    }
    for (const p of PROPS) {
      if (b.style[p] !== a.style[p]) {
        diffs.push({ key: b.key, prop: p, from: b.style[p], to: a.style[p] });
      }
    }
  }
  return diffs;
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const beforePath = join(DIR, 'before.json');
  const afterPath = join(DIR, 'after.json');

  if (phase === 'diff') {
    if (!existsSync(beforePath) || !existsSync(afterPath)) {
      console.error('缺少快照，先跑 before 和 after');
      process.exit(1);
    }
    const before = JSON.parse(readFileSync(beforePath, 'utf8'));
    const after = JSON.parse(readFileSync(afterPath, 'utf8'));
    const diffs = compare(before, after);

    if (diffs.length === 0) {
      console.log(
        `视觉等价 ✓（${before.length} 个元素 × ${PROPS.length} 个属性，零差异）`,
      );
      process.exit(0);
    }
    console.log(`发现 ${diffs.length} 处视觉差异：`);
    for (const d of diffs.slice(0, 40)) {
      console.log(`  ${d.key}\n    ${d.prop}: ${d.from}  →  ${d.to}`);
    }
    if (diffs.length > 40) console.log(`  …还有 ${diffs.length - 40} 处`);
    process.exit(1);
  }

  if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
    console.error('先跑 pnpm build');
    process.exit(1);
  }

  const b = await openBrowser({ baseUrl: BASE });
  try {
    await b.goto('/');
    // 注入代表性结构，否则首屏那些复杂类根本不存在（快照会漏掉它们）
    await b.evaluate(FIXTURE_FN);
    const snapshot = await b.evaluate(CAPTURE_FN);
    const target = phase === 'after' ? afterPath : beforePath;
    writeFileSync(target, JSON.stringify(snapshot), 'utf8');
    console.log(`已保存 ${phase}：${snapshot.length} 个元素 → ${target}`);
  } finally {
    await b.close();
  }
}

await main();
