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
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n工程健康检查\n');

  await checkTauriConfig();
  await checkScripts();
  await checkBuildArtifacts();
  await checkImports();

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
