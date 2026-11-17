/**
 * 九套风格方案截图：每套各拍一张，便于并排对比。
 *
 * 用法：
 *   node scripts/shoot-styles.mjs              # 九套 × 暗色
 *   node scripts/shoot-styles.mjs light        # 九套 × 亮色
 *   node scripts/shoot-styles.mjs both         # 两种主题都拍
 *
 * 需要先 `pnpm build` 并起服务：
 *   node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47911
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openBrowser } from './lib/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, '.ui-styles');
const BASE = process.env.OCX_URL ?? 'http://127.0.0.1:47911';

const STYLES = [
  ['', '0-当前正式'],
  ['a', 'A-VSCode工作台'],
  ['b', 'B-Linear高密度'],
  ['c', 'C-macOS-Raycast'],
  ['d', 'D-Windows11-Fluent'],
  ['e', 'E-Claude温暖人文'],
  ['f', 'F-Figma画布'],
  ['g', 'G-Vercel黑白'],
  ['h', 'H-Cloudscape状态'],
  ['i', 'I-M3Expressive'],
];

const arg = process.argv[2] ?? 'dark';
const THEMES = arg === 'both' ? ['dark', 'light'] : [arg];

mkdirSync(OUT, { recursive: true });

/**
 * 往对话区注入一段**固定的演示内容**。
 *
 * 为什么不用真发消息：占位 API Key 发不出真实回复，
 * 而九套风格最需要对比的恰恰是——消息气泡、Markdown 长文、
 * 代码块、表格、工具调用行的排版。
 *
 * 注入固定 DOM 的好处：**九套内容完全一致**，差异只来自风格，
 * 对比才公平。
 */
const INJECT_FN = `(() => {
  // 先去掉首次引导卡片（.onboarding），它会盖住我们要对比的消息区
  document.querySelectorAll('.onboarding').forEach((n) => n.remove());

  const box = document.querySelector('.messages');
  if (!box) return 'no-messages';
  box.innerHTML = '';
  // fixture：用**真实类名**（.message / .msg-role / .bubble），九套令牌才能作用到。
  // 内容要**短**——否则代码块和表格会被滚动区截断，九套就都看不到它们。
  box.insertAdjacentHTML('beforeend', \`
    <div class="message user">
      <span class="msg-role">你</span>
      <div class="bubble"><p>把 LoginForm 拆成受控组件，补一个邮箱校验。</p></div>
    </div>
    <div class="message assistant">
      <span class="msg-role">Assistant</span>
      <div class="bubble md-body">
        <h2>已改完</h2>
        <p>新增 <code>validate.ts</code>，改了 2 个文件、12 步。</p>
        <ul>
          <li><code>LoginForm.tsx</code>：受控输入</li>
          <li><code>validate.ts</code>：新增校验</li>
        </ul>
        <pre><code>export function isValidEmail(v: string) {
  return /@/.test(v);
}</code></pre>
        <table>
          <thead><tr><th>文件</th><th>变化</th></tr></thead>
          <tbody><tr><td>LoginForm.tsx</td><td>+18 −9</td></tr></tbody>
        </table>
      </div>
    </div>
  \`);
  return 'ok:' + box.children.length;
})()`;

/**
 * 往侧栏注入项目树 + 会话列表，让"密度"差异看得出来。
 */
const INJECT_SIDEBAR = `(() => {
  const tree = document.querySelector('.workspace-tree');
  if (!tree) return 'no-tree';
  tree.innerHTML = \`
    <div class="project-group">
      <div class="project-folder active">
        <span class="folder-icon">▾</span>
        <button class="folder-name-btn">demo-app</button>
      </div>
      <div class="thread-list">
        <button class="thread-item active"><span class="thread-title">登录页重构</span><span class="thread-status">2 分钟前</span></button>
        <button class="thread-item"><span class="thread-title">导出卡住的问题排查</span><span class="thread-status">1 小时前</span></button>
        <button class="thread-item"><span class="thread-title">补测试</span><span class="thread-status">昨天</span></button>
      </div>
    </div>
    <div class="project-group">
      <div class="project-folder">
        <span class="folder-icon">▸</span>
        <button class="folder-name-btn">另一个很长的项目名字</button>
      </div>
    </div>
  \`;
  return 'ok';
})()`;

// 视口要比默认高：默认 900px 会把代码块和表格裁在折叠线以下，
// 而它们正是九套风格差异最大的地方（代码配色、表格边框、行高）。
const b = await openBrowser({ baseUrl: BASE, width: 1440, height: 1400 });
try {
  for (const theme of THEMES) {
    for (const [id, label] of STYLES) {
      // 带 ?ui= 才会挂载切换器；这里直接用 data-style 控制
      await b.goto(`/?ui=${id}`);
      await b.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); true`);

      // **先进入项目**，否则看到的是空状态，九套风格完全看不出差异。
      await b.evaluate(`(() => {
        const folder = document.querySelector('.project-folder');
        folder?.click();
        return !!folder;
      })()`);
      await new Promise((r) => setTimeout(r, 900));

      // 注入固定内容（九套完全一致，差异只来自风格）
      const msgResult = await b.evaluate(INJECT_FN);
      const sideResult = await b.evaluate(INJECT_SIDEBAR);
      if (id === '' && theme === THEMES[0]) {
        console.log(`  注入：消息 ${msgResult} / 侧栏 ${sideResult}`);
      }

      // **等 React 完成一次重渲染再注入**，否则刚注入的 DOM 会被覆盖。
      // 这不是猜测：前几轮截图里 pre/table 消失就是被 React 的重渲染冲掉了。
      await new Promise((r) => setTimeout(r, 700));
      await b.evaluate(INJECT_FN);

      // 把消息区滚到顶部，保证从第一条开始拍
      await b.evaluate(`(() => {
        const box = document.querySelector('.messages');
        if (box) box.scrollTop = 0;
        return true;
      })()`);

      // 收起切换器，避免挡住界面
      await b.evaluate(`(() => {
        const root = document.getElementById('style-switcher-root');
        if (root) root.style.display = 'none';
        return !!root;
      })()`);
      await new Promise((r) => setTimeout(r, 400));

      // screenshot(name, dir)：name 不带扩展名
      const file = await b.screenshot(`${theme}-${label}`, OUT);
      console.log(`  ${file}`);
    }
  }
} finally {
  await b.close();
}

console.log(`\n共 ${THEMES.length * STYLES.length} 张，输出到 ${OUT}`);
