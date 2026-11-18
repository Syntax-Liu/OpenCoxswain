#!/usr/bin/env node
/**
 * 工程健康检查：找出"测试通过但构建会挂"的问题。
 *
 * ## 为什么需要
 *
 * 2026-11-13 归档 legacy 代码时踩了坑：
 * `typecheck` 通过、`test` 1076 条全过，但 `tauri build` 直接失败——
 * 因为 `tauri.conf.json` 的图标路径指向了刚归档的 `desktop/` 目录。
 *
 * **测试和类型检查都覆盖不到构建配置里的路径引用。**
 *
 * ## 检查什么
 *
 * 1. **配置里的相对路径是否都存在**（tauri.conf.json、tsconfig 等）
 * 2. **package.json 里的脚本引用的文件是否存在**
 * 3. **workspace 里的包是否都有构建产物**（缺产物 = 构建会挂）
 * 4. **有没有指向不存在目录的 import**
 *
 * 这些都是**静态可查**的，不需要真的跑构建。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const problems = [];
const checks = [];

function ok(msg) {
  checks.push({ status: 'pass', msg });
}
function bad(msg, detail) {
  checks.push({ status: 'fail', msg, detail });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. tauri.conf.json 里的路径
// ---------------------------------------------------------------------------
async function checkTauriConfig() {
  const confPath = path.join(ROOT, 'apps/shell/src-tauri/tauri.conf.json');
  if (!(await exists(confPath))) {
    ok('没有 tauri.conf.json（跳过）');
    return;
  }

  const raw = await readFile(confPath, 'utf8');
  const conf = JSON.parse(raw);
  const base = path.dirname(confPath);

  // 图标
  const icons = conf.bundle?.icon ?? [];
  let allOk = true;
  for (const icon of icons) {
    // 只检查本地相对路径（有些是绝对 URL）
    if (/^(https?:|@)/.test(icon)) continue;
    if (!(await exists(path.join(base, icon)))) {
      bad(`tauri.conf.json 的图标不存在: ${icon}`, `相对于 ${path.relative(ROOT, base)}`);
      allOk = false;
    }
  }
  if (icons.length > 0 && allOk) ok(`tauri 图标 ${icons.length} 个都存在`);

  // 绝对不能指向 legacy/
  if (/legacy\//.test(raw)) {
    bad('tauri.conf.json 引用了 legacy/ 目录', '归档的代码不该参与构建');
  } else {
    ok('tauri.conf.json 没有引用归档目录');
  }
}

// ---------------------------------------------------------------------------
// 2. package.json 脚本引用的文件
// ---------------------------------------------------------------------------
async function checkScripts() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  let checked = 0;
  let missing = 0;

  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    // 抓 `node scripts/xxx.mjs` 或 `node xxx.js` 这种
    for (const m of String(cmd).matchAll(/node\s+([\w./-]+\.(?:mjs|js|cjs))/g)) {
      const file = m[1];
      if (file.startsWith('-')) continue;
      checked += 1;
      if (!(await exists(path.join(ROOT, file)))) {
        bad(`脚本 "${name}" 引用的文件不存在: ${file}`);
        missing += 1;
      }
    }
  }

  if (missing === 0 && checked > 0) ok(`package.json 脚本 ${checked} 处文件引用都存在`);
}

// ---------------------------------------------------------------------------
// 3. workspace 包的构建产物
// ---------------------------------------------------------------------------
async function checkBuildArtifacts() {
  const workspace = ['apps/runtime', 'apps/web', 'apps/shell'];
  let okCount = 0;

  for (const dir of workspace) {
    const pkgPath = path.join(ROOT, dir, 'package.json');
    if (!(await exists(pkgPath))) continue;
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));

    // 有 build 脚本的，dist 应该存在（除非从没构建过）
    if (pkg.scripts?.build) {
      const distDir = path.join(ROOT, dir, 'dist');
      if (await exists(distDir)) {
        okCount += 1;
      } else {
        // 第一次 clone 时还没有 dist 是正常的，只警告
        checks.push({
          status: 'info',
          msg: `${dir} 还没有构建产物（dist/ 不存在）`,
          detail: '跑一次 pnpm build 就有了',
        });
      }
    }
  }

  if (okCount > 0) ok(`${okCount} 个包有构建产物`);
}

// ---------------------------------------------------------------------------
// 4. 源码里指向不存在目录的相对引用
// ---------------------------------------------------------------------------
async function checkImports() {
  const dirs = ['apps/runtime/src', 'apps/web/src'];
  let scanned = 0;
  let broken = 0;

  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    if (!(await exists(full))) continue;

    const files = await collect(full, ['.ts', '.tsx']);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      scanned += 1;

      // 只看指向 ../../ 这种跨包引用
      for (const m of text.matchAll(/from\s+['"](\.[^'"]*packages\/[^'"]+)['"]/g)) {
        const target = m[1];
        // 解析成实际路径（去掉 .js 后缀）
        const resolved = path.resolve(path.dirname(file), target.replace(/\.js$/, ''));
        const candidates = [resolved, `${resolved}.ts`, path.join(resolved, 'index.ts')];
        const found = await Promise.any(candidates.map((c) => exists(c).then((x) => (x ? c : Promise.reject())))).catch(
          () => null,
        );
        if (!found) {
          bad(`${path.relative(ROOT, file)} 引用了不存在的包: ${target}`);
          broken += 1;
        }
      }
    }
  }

  if (broken === 0) ok(`扫描 ${scanned} 个源文件，没有跨包断链`);
}

async function collect(dir, exts) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...(await collect(full, exts)));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. PowerShell 脚本的 UTF-8 BOM
// ---------------------------------------------------------------------------
/**
 * 含中文的 .ps1 必须有 BOM，否则 Windows PowerShell 5.1 按 GBK 读，
 * 中文变乱码、引号被吃掉、整个文件解析失败——但 `pnpm test` 完全看不见
 * （它是 PowerShell，不是 JS）。
 *
 * 这个坑踩过两次：第二次是修好之后，编辑器改一行又把 BOM 丢了。
 * 所以必须在健康检查里守着，否则"改一行就让出包脚本坏掉"会反复发生。
 */
async function checkPs1Bom() {
  const skip = new Set(['node_modules', 'target', 'dist', 'dist-test', '.git', '.trae-html-share-packages']);
  const found = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        await walk(full);
      } else if (e.name.toLowerCase().endsWith('.ps1')) {
        found.push(full);
      }
    }
  }
  await walk(ROOT);

  if (found.length === 0) return;

  let allOk = true;
  for (const file of found) {
    const buf = await readFile(file);
    const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const hasNonAscii = /[^\x00-\x7F]/.test(text);
    if (hasNonAscii && !hasBom) {
      bad(
        `${path.relative(ROOT, file).replace(/\\/g, '/')} 含中文但没有 UTF-8 BOM`,
        'PowerShell 5.1 会按 GBK 读它，解析直接失败。补三个字节 EF BB BF。',
      );
      allOk = false;
    }
  }
  if (allOk) ok(`${found.length} 个 .ps1 的 BOM 都正确`);
}

// ---------------------------------------------------------------------------
// 6. 换行风格（防止 diff 变成整文件重写）
// ---------------------------------------------------------------------------
/**
 * 改动一个文件时，不许把它原本的换行风格换掉。
 *
 * 2026-11-17 踩过：编辑工具把 LF 文件整体转成 CRLF，
 * 一个 26 行的改动画成了 1330 insertions / 820 deletions——
 * 功能没坏，但评审彻底失效。
 *
 * 完整规则见 `scripts/check-eol.mjs`（也支持 `--fix` 自动还原）。
 */
async function checkEol() {
  const script = path.join(ROOT, 'scripts/check-eol.mjs');
  if (!(await exists(script))) {
    checks.push({ status: 'info', msg: 'check-eol.mjs 不存在，跳过换行检查' });
    return;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
    ok(stdout.trim().split('\n').pop() ?? '换行检查通过');
  } catch (error) {
    const stdout = String(error.stdout ?? '');
    const stderr = String(error.stderr ?? '');
    const detail = (stderr || stdout).trim();
    bad(
      '有文件的换行风格被改动了',
      `${detail}\n修复：node scripts/check-eol.mjs --fix`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. 文档完整性（图片存在、锚点有效）
// ---------------------------------------------------------------------------
/**
 * 文档里的图片路径写错、锚点指向不存在的标题——
 * 这两种腐烂只在别人点开时才发现。
 *
 * `ui-dev-guide.md` 现在有 9 张控件截图和 30 个站内锚点，
 * 靠人肉核对不现实。
 */
async function checkDocs() {
  const script = path.join(ROOT, 'scripts/check-doc.mjs');
  if (!(await exists(script))) {
    checks.push({ status: 'info', msg: 'check-doc.mjs 不存在，跳过文档检查' });
    return;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
    const lines = stdout.trim().split('\n');
    const summary = lines.find((l) => l.includes('图片')) ?? '';
    ok(`文档完整：${summary}`);
  } catch (error) {
    const detail = String(error.stdout ?? error.stderr ?? '').trim();
    bad('文档里有失效的图片或锚点', detail);
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n工程健康检查\n');

  await checkTauriConfig();
  await checkScripts();
  await checkBuildArtifacts();
  await checkImports();
  await checkPs1Bom();
  await checkEol();
  await checkDocs();

  for (const c of checks) {
    const icon = c.status === 'pass' ? '✓' : c.status === 'info' ? '·' : '✗';
    console.log(`  ${icon} ${c.msg}`);
    if (c.detail) console.log(`      ${c.detail}`);
  }

  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n${fails.length === 0 ? '全部通过' : `${fails.length} 项未通过`}\n`);

  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('检查本身出错:', e);
  process.exit(2);
});
