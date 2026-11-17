/**
 * 生成九套风格的并排对比页。
 *
 * 产出 `.ui-styles/index.html`：左列是暗色、右列是亮色，
 * 每行一套方案，方便一次看完差异。
 *
 * 用法：先跑 scripts/shoot-styles.mjs both，再跑这个。
 */
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIR = join(ROOT, '.ui-styles');

if (!existsSync(DIR)) {
  console.error('先跑 node scripts/shoot-styles.mjs both');
  process.exit(1);
}

/** 方案说明，与 styles-preview.css 里的注释对应。 */
const PLANS = [
  ['0-当前正式', '当前正式', '现在线上的样子，作为基准'],
  ['A-VSCode工作台', 'A · VS Code 工作台', '证据优先，装饰让位内容；圆角收紧、边框变实'],
  ['B-Linear高密度', 'B · Linear 高密度', '色调台阶叠层级，暗色优先；每级只差一点明度'],
  ['C-macOS-Raycast', 'C · macOS + Raycast', '圆角明显更大、间距更松、浮层更柔'],
  ['D-Windows11-Fluent', 'D · Windows 11 Fluent', '直角偏方、强调色克制；平台补丁性质'],
  ['E-Claude温暖人文', 'E · Claude 温暖人文', '暖色底、行高最松；从"读起来累不累"出发'],
  ['F-Figma画布', 'F · Figma 画布', '边框几乎消失，靠留白分组，让内容说话'],
  ['G-Vercel黑白', 'G · Vercel 黑白', '只有黑白灰 + 字重，颜色只留给状态'],
  ['H-Cloudscape状态', 'H · Cloudscape 状态', '密度最高、状态色最饱和，少误判优先'],
  ['I-M3Expressive', 'I · M3 Expressive', '大圆角 + 弹簧感；保留它是为了对比"为什么不该用"'],
];

const files = new Set(readdirSync(DIR));

const rows = PLANS.map(([key, title, note]) => {
  const dark = `dark-${key}.png`;
  const light = `light-${key}.png`;
  const hasDark = files.has(dark);
  const hasLight = files.has(light);
  return `
  <section class="plan">
    <header>
      <h2>${title}</h2>
      <p>${note}</p>
    </header>
    <div class="shots">
      <figure>
        <figcaption>暗色</figcaption>
        ${hasDark ? `<a href="${dark}" target="_blank"><img src="${dark}" alt="${title} 暗色" loading="lazy"></a>` : '<div class="missing">缺图</div>'}
      </figure>
      <figure>
        <figcaption>亮色</figcaption>
        ${hasLight ? `<a href="${light}" target="_blank"><img src="${light}" alt="${title} 亮色" loading="lazy"></a>` : '<div class="missing">缺图</div>'}
      </figure>
    </div>
  </section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>九套风格方案对比</title>
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #111; color: #e6e6e6;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lead { color: #999; margin: 0 0 28px; max-width: 900px; }
  .plan { margin-bottom: 44px; border-top: 1px solid #2a2a2a; padding-top: 20px; }
  .plan header h2 { font-size: 17px; margin: 0 0 2px; }
  .plan header p { color: #8d8d8d; margin: 0 0 14px; font-size: 13px; }
  .shots { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  figure { margin: 0; }
  figcaption {
    font-size: 12px; color: #777; margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: .08em;
  }
  img {
    width: 100%; height: auto; display: block;
    border-radius: 6px; border: 1px solid #2c2c2c;
    background: #000;
  }
  .missing {
    padding: 40px; text-align: center; color: #666;
    border: 1px dashed #333; border-radius: 6px;
  }
  @media (max-width: 900px) { .shots { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <h1>九套风格方案对比</h1>
  <p class="lead">
    同一份演示内容（同样的消息、代码块、表格、侧栏树），只换风格令牌。
    左边暗色、右边亮色。<b>点击任意图可看原图</b>。
    想亲手切换：打开应用，URL 加 <code>?ui=a</code>（a–i 对应九套），
    或直接按数字键 1–9。
  </p>
${rows}
</body>
</html>`;

const out = join(DIR, 'index.html');
writeFileSync(out, html, 'utf8');
console.log(`对比页已生成：${out}`);
