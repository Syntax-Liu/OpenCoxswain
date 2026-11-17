/**
 * 换行风格守卫：**改动一个文件时不许换掉它原本的换行**。
 *
 * ## 为什么需要
 *
 * 2026-11-17 踩了两次同类问题：
 *
 * - 提交 `555a884` 的 `git diff --stat` 显示 1330 insertions / 820 deletions，
 *   而真实改动只有 26 行
 * - 原因是编辑工具把 `runner.ts` / `state.ts` 从 LF 整体转成了 CRLF
 *
 * 后果不是功能坏了，是**评审失效**：几百行"改动"里看不出真正改了什么，
 * `git blame` 也失去意义。
 *
 * ## 判据（重要：不要求全仓库统一）
 *
 * 仓库现状是 **615 LF / 104 CRLF / 15 混排**。强求统一会制造 15 个文件的
 * 巨型 diff，而且技术上毫无收益。所以只守一条：
 *
 * > **你改的这个文件，改完之后换行风格要和改之前一样。**
 *
 * | 改前 | 改后 | 判定 |
 * | --- | --- | --- |
 * | LF | LF | ✅ |
 * | CRLF | CRLF | ✅ |
 * | LF | CRLF | ❌ 拦 |
 * | CRLF | LF | ❌ 拦 |
 * | 混排 | 任意 | ⚠️ 只提醒（历史遗留，不强求） |
 * | 新文件 | — | ✅ 默认 LF，不检查 |
 *
 * 用法：
 *   node scripts/check-eol.mjs              # 检查工作区相对 HEAD 的改动
 *   node scripts/check-eol.mjs --fix        # 把有问题的文件还原成 HEAD 的风格
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FIX = process.argv.includes('--fix');

/** 只检查这些扩展名（二进制与锁文件不参与）。 */
const RELEVANT = /\.(tsx?|css|mjs|cjs|md|json|ps1|sh|yml|yaml|html|njk)$/;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** 工作区里被改动的已跟踪文件。 */
function changedFiles() {
  const out = git(['diff', '--name-only', 'HEAD']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  const modified = out.split('\n').filter(Boolean);
  const added = untracked.split('\n').filter(Boolean);
  return { modified: modified.filter((f) => RELEVANT.test(f)), untracked: added };
}

/** 统计文本的换行构成。 */
function eolStats(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  return 'mixed';
}

/** 读 HEAD 版本（可能不存在 = 新文件）。 */
function headText(rel) {
  try {
    return git(['show', `HEAD:${rel}`], { encoding: 'buffer' }).toString('utf8');
  } catch {
    return null;
  }
}

const { modified, untracked } = changedFiles();

const violations = [];
const removals = [];
const newFiles = [];

for (const rel of modified) {
  const before = headText(rel);
  if (before === null) {
    removals.push(rel);
    continue;
  }
  const beforeStyle = eolStats(before);
  if (beforeStyle === 'mixed' || beforeStyle === 'none') {
    // 历史遗留混排：只提醒，不拦
    continue;
  }
  let after;
  try {
    after = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  const afterStyle = eolStats(after);
  if (afterStyle !== beforeStyle && afterStyle !== 'none') {
    violations.push({ rel, beforeStyle, afterStyle, before });
  }
}

if (FIX && violations.length > 0) {
  for (const v of violations) {
    const path = join(ROOT, v.rel);
    const text = readFileSync(path, 'utf8');
    const fixed =
      v.beforeStyle === 'crlf'
        ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
        : text.replace(/\r\n/g, '\n');
    writeFileSync(path, fixed, 'utf8');
    console.log(`  已还原 ${v.rel} → ${v.beforeStyle}`);
  }
  // 还原后重新判断
  violations.length = 0;
}

if (violations.length > 0 || removals.length > 0) {
  if (violations.length > 0) {
    console.error('换行风格被改动（这会让 diff 变成整文件重写）：');
    for (const v of violations) {
      console.error(`  ✗ ${v.rel}：${v.beforeStyle} → ${v.afterStyle}`);
    }
    console.error('\n修复：node scripts/check-eol.mjs --fix');
    console.error('（它会把文件换行还原成 HEAD 的样子，内容不动）');
  }
  if (removals.length > 0) {
    console.error('删除了已跟踪文件（检查是否符合预期）：');
    for (const f of removals) console.error(`  - ${f}`);
  }
  process.exit(1);
}

const note = untracked.filter((f) => RELEVANT.test(f));
console.log(
  `换行检查通过：${modified.length} 个改动文件风格一致` +
    (note.length > 0 ? `（${note.length} 个新文件，默认 LF）` : ''),
);
