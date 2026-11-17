/**
 * 把本次版本的安装包归档到 `dist-installers/`。
 *
 * ## 为什么需要
 *
 * `bundle/nsis/` 在 `target/` 里，而 `target/` 是 Cargo 的临时区——
 * 一次 `cargo clean` 或手工清理，历史安装包就全没了。
 * 已经真丢过一次：0.113.2 ~ 0.117.0 那 19 个包只剩 `.sig`，`.exe` 全丢。
 *
 * ## 为什么是独立的 Node 脚本，而不是写在 PowerShell 里
 *
 * 1. **能单独跑**：验证归档逻辑不需要重跑 6 分钟出包，1 秒就够；
 * 2. **能测**：Node 脚本可以直接断言，PowerShell 不行；
 * 3. **路径处理统一**：用 `import.meta.dirname` 定位仓库根，
 *    不依赖 PowerShell 的当前目录与 `$PSScriptRoot` 差异。
 *
 * ## 行为
 *
 * - 复制（**不是移动**）本次版本的 `.exe` / `.sig` / `latest.json` 到 `dist-installers/`；
 * - 目标已存在且大小相同就跳过，不重复拷贝 25 MB；
 * - 任一份失败**不 exit 1**——包本身已经产出了，只是少一份副本，
 *   由调用方（build-app.ps1）决定是否只告警；
 * - 但「一份都没找到」会被视为异常，exit 1，因为这通常意味着打包根本没成功。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/archive-installer.mjs           # 用 package.json 里的版本
 * node scripts/archive-installer.mjs 0.118.1   # 显式指定
 * ```
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const NSIS = join(ROOT, 'apps/shell/src-tauri/target/release/bundle/nsis');
const ARCHIVE = join(ROOT, 'dist-installers');

function resolveVersion() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (arg) return arg;
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

const version = resolveVersion();
const sourceFiles = [
  `OpenCoxswain_${version}_x64-setup.exe`,
  `OpenCoxswain_${version}_x64-setup.exe.sig`,
  'latest.json',
].map((name) => join(NSIS, name));

if (!existsSync(NSIS)) {
  console.error(`找不到打包目录：${NSIS}`);
  console.error('先跑一次出包（build-app.cmd）。');
  process.exit(1);
}

// latest.json 是共享文件名，只有它属于"本次版本"才归档——
// 否则可能把上一版的清单复制进来，覆盖错版本。
const manifest = sourceFiles.find((f) => basename(f) === 'latest.json');
const present = sourceFiles.filter((f) => existsSync(f));

if (present.length === 0) {
  console.error(`没找到 ${version} 的任何产物，归档中止。`);
  console.error(`目录：${NSIS}`);
  process.exit(1);
}

if (present.includes(manifest)) {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    if (parsed.version !== version) {
      console.warn(
        `  ! latest.json 的版本是 ${parsed.version}，与目标 ${version} 不一致，跳过它`,
      );
      present.splice(present.indexOf(manifest), 1);
    }
  } catch {
    console.warn('  ! latest.json 解析失败，跳过它');
    present.splice(present.indexOf(manifest), 1);
  }
}

mkdirSync(ARCHIVE, { recursive: true });

// 过滤掉 latest.json 之后可能一个都不剩（比如指定了一个根本不存在的版本）。
// 必须在过滤后重新判断——放在前面判断会漏掉这种情况：
// latest.json 永远存在，但它只对"当前版本"有效，不能代表目标版本有产物。
if (present.length === 0) {
  console.error(`没找到 ${version} 的任何产物（只找到不属于该版本的 latest.json），归档中止。`);
  console.error(`目录：${NSIS}`);
  process.exit(1);
}

let copied = 0;
let skipped = 0;
const failed = [];

for (const file of present) {
  const name = basename(file);
  const dest = join(ARCHIVE, name);
  try {
    // 已存在且大小一致 = 内容大概率相同，跳过 25 MB 的重复拷贝
    if (existsSync(dest) && statSync(dest).size === statSync(file).size) {
      console.log(`  = ${name}（已是最新，跳过）`);
      skipped += 1;
      continue;
    }
    copyFileSync(file, dest);
    console.log(`  ✓ ${name}`);
    copied += 1;
  } catch (err) {
    console.error(`  ✗ ${name} — ${err.message}`);
    failed.push(name);
  }
}

console.log('');
console.log(`归档到 ${ARCHIVE}`);
console.log(`  复制 ${copied}，跳过 ${skipped}，失败 ${failed.length}`);

// 复制失败不阻断——包已经产出了。但调用方会看到非 0 以便记录告警。
process.exit(failed.length > 0 ? 2 : 0);
