/**
 * 安装最新出好的包（`pnpm app:install`）。
 *
 * ## 为什么需要这个脚本
 *
 * 用户的原话：「你能不能每次更新完之后帮我装？」
 *
 * 出包之后手动装一次很麻烦，而且失败时信息很少——NSIS 只弹一句
 * `Error writing temporary file`，看不出到底是空间、权限还是旧版占用。
 *
 * 这个脚本把**装之前该检查的都查一遍**，把结论用中文说清楚，
 * 再启动安装器。装不装得成，取决于你能不能点 UAC。
 *
 * ## 它检查什么（顺序即排查优先级）
 *
 * | # | 检查 | 失败意味着 |
 * | --- | --- | --- |
 * | 1 | `dist-installers/` 里有最新版本 | 还没出包 |
 * | 2 | exe 与 .sig 都在、exe 大小正常 | 包损坏或签名缺失 |
 * | 3 | 旧版本进程是否在跑 | 覆盖安装会失败 |
 * | 4 | 系统盘（TEMP 所在卷）剩余空间 | **NSIS 解压失败的最常见原因** |
 * | 5 | 已安装版本 vs 待装版本 | 防止装了个更旧的 |
 * | 6 | 安装目标目录是否可写 | 权限不足的早期信号 |
 *
 * ## 为什么安装本身仍需你点
 *
 * NSIS 安装器会改注册表、写程序目录。即使脚本能拉起它，
 * UAC 弹窗也只有**你能点**。所以脚本做到"启动"就交给你。
 *
 * ## 用法
 *
 * ```bash
 * pnpm app:install            # 检查 + 启动安装器
 * pnpm app:install --dry-run  # 只检查，不启动
 * ```
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ARCHIVE = join(ROOT, 'dist-installers');
const DRY = process.argv.includes('--dry-run');

const problems = [];
const warnings = [];

function fail(msg, hint) {
  problems.push({ msg, hint });
}
function warn(msg, hint) {
  warnings.push({ msg, hint });
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function info(msg) {
  console.log(`  · ${msg}`);
}

function gb(bytes) {
  return (bytes / 1073741824).toFixed(1);
}

// ---------------------------------------------------------------------------
console.log('\n安装最新包\n');

// 1) 找最新版本
if (!existsSync(ARCHIVE)) {
  console.error(`找不到 ${ARCHIVE}。先跑一次 pnpm app:build。`);
  process.exit(1);
}

const installers = readdirSync(ARCHIVE)
  .filter((n) => /^OpenCoxswain_.+_x64-setup\.exe$/.test(n))
  .map((name) => {
    const full = join(ARCHIVE, name);
    return { name, full, version: name.replace(/^OpenCoxswain_/, '').replace(/_x64-setup\.exe$/, ''), mtime: statSync(full).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (installers.length === 0) {
  console.error('dist-installers/ 里没有安装包。先跑 pnpm app:build。');
  process.exit(1);
}

const target = installers[0];
const sigPath = `${target.full}.sig`;

info(`最新包：${target.name}`);
info(`生成于：${new Date(target.mtime).toLocaleString('zh-CN')}`);

// 2) 包完整性
const exeSize = statSync(target.full).size;
if (exeSize < 10 * 1048576) {
  fail(`安装包只有 ${(exeSize / 1048576).toFixed(1)} MB，明显偏小`, '多半是出包中断了，重新出包');
} else {
  ok(`安装包 ${(exeSize / 1048576).toFixed(1)} MB`);
}
if (existsSync(sigPath)) ok('签名文件存在');
else warn('没有 .sig 文件，自动更新会失效（手动安装不受影响）');

// 3) 旧版本是否在运行
function running() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq opencoxswain.exe', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /opencoxswain\.exe/i.test(out);
  } catch {
    return false;
  }
}

if (running()) {
  fail('OpenCoxswain 正在运行', '先退出（托盘菜单 → 退出），否则文件被占用，安装会失败');
} else {
  ok('没有正在运行的实例');
}

// 4) 空间：TEMP 所在卷（NSIS 解压用）+ 安装目标卷
function freeSpace(path) {
  try {
    // PowerShell 拿剩余空间，跨盘可靠
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-PSDrive -Name ([System.IO.Path]::GetPathRoot('${path.replace(/'/g, "''")}').Substring(0,1))).Free`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return Number(out.trim());
  } catch {
    return null;
  }
}

const tempDir = process.env.TEMP ?? 'C:\\Windows\\Temp';
const tempFree = freeSpace(tempDir);
if (tempFree !== null) {
  if (tempFree < 1 * 1073741824) {
    fail(`TEMP 所在卷只剩 ${gb(tempFree)} GB`, `NSIS 要先把包解压到这里。清理 ${tempDir} 或把 TEMP 指到别的盘`);
  } else if (tempFree < 3 * 1073741824) {
    warn(`TEMP 所在卷只剩 ${gb(tempFree)} GB`, '偏紧，安装可能失败');
  } else {
    ok(`TEMP 所在卷剩余 ${gb(tempFree)} GB`);
  }
}

// 5) 已安装版本
function installedVersion() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenCoxswain' -ErrorAction SilentlyContinue).DisplayVersion"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function installedLocation() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OpenCoxswain' -ErrorAction SilentlyContinue).InstallLocation"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out.replace(/^"|"$/g, '') || null;
  } catch {
    return null;
  }
}

const current = installedVersion();
const location = installedLocation();

if (current) {
  info(`已安装：${current}，位于 ${location ?? '(未知)'}`);
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  if (cmp(target.version, current) < 0) {
    fail(`要装的是 ${target.version}，比已装的 ${current} 还旧`, '确认 dist-installers 里选对了包');
  } else if (cmp(target.version, current) === 0) {
    warn(`已装的就是 ${current}，重复安装只是覆盖`, '如果只是想验证，可以跳过');
  } else {
    ok(`将升级 ${current} → ${target.version}`);
  }
} else {
  info('检测不到已安装版本（首次安装或注册表里没有）');
}

// 6) 安装目标目录可写性
if (location) {
  try {
    const probe = join(location, '.ocx-write-probe');
    execFileSync('powershell', ['-NoProfile', '-Command', `Set-Content -Path '${probe.replace(/'/g, "''")}' -Value x -ErrorAction Stop; Remove-Item '${probe.replace(/'/g, "''")}' -Force`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    ok(`安装目标目录可写：${location}`);
  } catch {
    warn(`安装目标目录当前不可写：${location}`, '安装器可能会申请管理员权限（会弹 UAC）');
  }
}

// ---------------------------------------------------------------------------
console.log('');

if (warnings.length > 0) {
  console.log('提醒：');
  for (const w of warnings) {
    console.log(`  ! ${w.msg}`);
    if (w.hint) console.log(`      ${w.hint}`);
  }
  console.log('');
}

if (problems.length > 0) {
  console.log('不能安装：');
  for (const p of problems) {
    console.log(`  ✗ ${p.msg}`);
    if (p.hint) console.log(`      → ${p.hint}`);
  }
  console.log('');
  process.exit(1);
}

console.log(`准备安装：${target.name}`);
console.log('');

if (DRY) {
  console.log('[dry-run] 检查通过，未启动安装器。');
  process.exit(0);
}

// 启动安装器。用户能看到 NSIS 的进度窗口，必要时自己点 UAC。
//
// `detached` + `unref`：让安装器独立于当前终端，终端关掉也不影响安装。
const child = spawn(target.full, [], { detached: true, stdio: 'ignore' });
child.unref();

console.log('安装器已启动。');
console.log('  · 它会覆盖当前安装，数据（%LOCALAPPDATA%\\OpenCoxswain）不受影响');
console.log('  · Windows 可能提示"未知发布者"——点 更多信息 → 仍要运行');
console.log('  · 如果弹 UAC，点"是"');
