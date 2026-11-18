/**
 * 文档自检：图片是否存在、站内锚点是否对得上标题。
 *
 * "图片路径写错""锚点指向不存在的标题"是文档最常见的两种腐烂，
 * 而且只在别人点开时才发现。这里提前查出来。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const FILE = 'docs/ui-dev-guide.md';
const base = dirname(FILE);
const text = readFileSync(FILE, 'utf8');

/** GitHub 的锚点生成规则（近似）：小写、去标点、空格转连字符。 */
function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-');
}

// 1) 收集文中所有标题的锚点
const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? ''));
const headingSet = new Set(headings);

// 2) 图片
const imgs = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
const missingImgs = imgs.filter((p) => !existsSync(resolve(base, p)));

// 3) 站内锚点
const anchors = [...text.matchAll(/\[[^\]]*\]\(#([^)]+)\)/g)].map((m) => m[1]);
const badAnchors = anchors.filter((a) => !headingSet.has(a));

console.log(`标题 ${headings.length} 个`);
console.log(`图片 ${imgs.length} 个，缺失 ${missingImgs.length}`);
if (missingImgs.length) for (const m of missingImgs) console.log(`  ✗ ${m}`);
console.log(`站内锚点 ${anchors.length} 个，失效 ${badAnchors.length}`);
if (badAnchors.length) for (const a of badAnchors) console.log(`  ✗ #${a}`);

process.exit(missingImgs.length + badAnchors.length > 0 ? 1 : 0);
