/**
 * 文档自检：图片是否存在、站内锚点是否对得上标题。
 *
 * "图片路径写错""锚点指向不存在的标题"是文档最常见的两种腐烂，
 * 而且只在别人点开时才发现。这里提前查出来。
 *
 * 检查多个文档：每个文件的图片路径按**它自己所在的目录**解析。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FILES = [
  'docs/ui-dev-guide.md',
  'docs/design-research/05-vs-dsh-source.md',
  'docs/control-spec.md',
];

/** GitHub 的锚点生成规则（近似）：小写、去标点、空格转连字符。 */
function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-');
}

let totalImgs = 0;
let totalAnchors = 0;
const problems = [];

for (const file of FILES) {
  if (!existsSync(file)) {
    problems.push(`缺文件：${file}`);
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const base = dirname(file);

  // 1) 标题锚点（只看本文件内的）
  const headingSet = new Set(
    [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? '')),
  );

  // 2) 图片
  const imgs = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p && !/^https?:/.test(p));
  totalImgs += imgs.length;
  for (const p of imgs) {
    if (!existsSync(resolve(base, p))) problems.push(`${file} 图片缺失：${p}`);
  }

  // 3) 站内锚点
  const anchors = [...text.matchAll(/\[[^\]]*\]\(#([^)]+)\)/g)].map((m) => m[1] ?? '');
  totalAnchors += anchors.length;
  for (const a of anchors) {
    if (!headingSet.has(a)) problems.push(`${file} 锚点失效：#${a}`);
  }
}

console.log(`检查 ${FILES.length} 份文档`);
console.log(`图片 ${totalImgs} 个，站内锚点 ${totalAnchors} 个`);
if (problems.length) {
  console.log(`问题 ${problems.length} 个：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
} else {
  console.log('全部有效（图片 0 缺失，锚点 0 失效）');
}

process.exit(problems.length > 0 ? 1 : 0);
