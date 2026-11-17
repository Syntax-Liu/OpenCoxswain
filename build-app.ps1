# 一键出包（Windows）
#
# 用法：在本目录双击 build-app.cmd，或在 PowerShell 里运行：
#   powershell -ExecutionPolicy Bypass -File .\build-app.ps1
#
# 它会依次：
#   1. 检查 Node / pnpm / Rust 工具链
#   2. 安装依赖
#   3. 构建运行时与界面
#   4. 摊平资源到桌面壳
#   5. 打包 NSIS 安装包
#   6. 打开产物所在目录
#
# 任何一步失败都会停下来并打印可读原因，不会继续往下走。

#Requires -Version 5.1
[CmdletBinding()]
param(
  # 跳过依赖安装（依赖没变时可加快）
  [switch]$SkipInstall,
  # 只构建、不打包（用于快速验证）
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 切到仓库根（脚本在仓库根目录）
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RepoRoot

function Write-Step($message) {
  Write-Host ""
  Write-Host "──── $message " -ForegroundColor Cyan -NoNewline
  Write-Host ("─" * [Math]::Max(0, 60 - $message.Length)) -ForegroundColor DarkGray
}

function Write-Ok($message) { Write-Host "  ✓ $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "  ! $message" -ForegroundColor Yellow }

function Fail($message, $hint) {
  Write-Host ""
  Write-Host "✗ 打包失败：$message" -ForegroundColor Red
  if ($hint) { Write-Host "  提示：$hint" -ForegroundColor Yellow }
  Write-Host ""
  exit 1
}

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# 1. 工具链检查
# ---------------------------------------------------------------------------
Write-Step "检查工具链"

if (-not (Test-Command 'node')) {
  Fail '找不到 Node.js。' '请安装 Node.js >= 22：https://nodejs.org/'
}
$nodeVersion = (node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 22) {
  Fail "Node.js 版本过低（当前 $nodeVersion，需要 >= 22）。" '运行时使用内置的 node:sqlite，需要 Node 22 以上。'
}
Write-Ok "Node.js $nodeVersion"

if (-not (Test-Command 'pnpm')) {
  Fail '找不到 pnpm。' '运行 corepack enable，或 npm i -g pnpm'
}
Write-Ok "pnpm $(pnpm --version)"

if (-not (Test-Command 'cargo')) {
  Fail '找不到 Rust 工具链（cargo）。' '安装 Rust：https://rustup.rs/ 并确保选择 MSVC 工具链。'
}
Write-Ok "cargo $((cargo --version) -replace 'cargo ', '')"

# MSVC 链接器是 Tauri 打包的硬依赖，提前检查比编译到一半才发现好。
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
  Write-Ok 'Visual Studio / MSVC 已安装'
} else {
  Write-Warn2 '没检测到 Visual Studio（vswhere）。如果编译时报 linker 错误，请安装 VS Build Tools + Windows SDK。'
}

# ---------------------------------------------------------------------------
# 2. 依赖
# ---------------------------------------------------------------------------
if (-not $SkipInstall) {
  Write-Step '安装依赖'
  # CI=true 让 pnpm 在需要重建 node_modules 时不再交互式询问；
  # --no-frozen-lockfile 允许 package.json 与 lockfile 有合理差异。
  $env:CI = 'true'
  pnpm install --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Fail '依赖安装失败。' '检查网络后重试，或删除 node_modules 后重新运行。' }
  Write-Ok '依赖已就绪'
} else {
  Write-Warn2 '已跳过依赖安装（-SkipInstall）'
}

# ---------------------------------------------------------------------------
# 3. 构建运行时与界面
# ---------------------------------------------------------------------------
Write-Step '同步版本号'
node scripts/version.mjs sync
if ($LASTEXITCODE -ne 0) { Fail '版本号同步失败。' '检查 scripts/version.mjs。' }
$appVersion = node scripts/version.mjs show
Write-Ok "版本 $appVersion"

Write-Step '构建运行时'
pnpm --filter @opencoxswain/runtime build
if ($LASTEXITCODE -ne 0) { Fail '运行时构建失败。' '先单独运行 pnpm --filter @opencoxswain/runtime build 看具体错误。' }
Write-Ok '运行时构建完成'

Write-Step '构建界面'
pnpm --filter @opencoxswain/web build
if ($LASTEXITCODE -ne 0) { Fail '界面构建失败。' '先单独运行 pnpm --filter @opencoxswain/web build 看具体错误。' }
Write-Ok '界面构建完成'

# ---------------------------------------------------------------------------
# 4. 摊平打包资源
# ---------------------------------------------------------------------------
Write-Step '准备打包资源'
node scripts/stage-shell.mjs
if ($LASTEXITCODE -ne 0) { Fail '资源暂存失败。' '检查 scripts/stage-shell.mjs 的输出。' }
Write-Ok '资源已就绪'

if ($BuildOnly) {
  Write-Step '仅构建模式：检查 Rust 可编译'
  cargo check --manifest-path apps/shell/src-tauri/Cargo.toml
  if ($LASTEXITCODE -ne 0) { Fail 'Rust 编译检查失败。' '看上面的 error 行。' }
  Write-Ok 'Rust 编译检查通过'
  Write-Host ""
  Write-Host '✓ 构建完成（未打包）。去掉 -BuildOnly 即可出安装包。' -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------------------
# 5. 打包
# ---------------------------------------------------------------------------
Write-Step '编译并打包桌面应用'

# 自动更新需要签名：没有私钥也能构建，只是不产出 .sig / latest.json。
# **必须在 tauri build 之前设好**——它读的是环境变量。
$signingKey = $env:TAURI_SIGNING_PRIVATE_KEY
if (-not $signingKey) {
  $defaultKey = Join-Path $env:USERPROFILE '.opencoxswain\updater.key'
  if (Test-Path $defaultKey) {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $defaultKey -Raw).Trim()
    Write-Ok "使用本地更新签名私钥：$defaultKey"
  }
  else {
    Write-Host '  ! 没找到更新签名私钥，本次不会产出可自动更新的安装包。' -ForegroundColor Yellow
    Write-Host '    生成：pnpm --filter @opencoxswain/shell exec tauri signer generate -w <路径>' -ForegroundColor Gray
  }
}

# **只调一次 tauri build**。
#
# 以前这里先手工 `cargo build --release --offline`，再跑 `tauri build --no-bundle`，
# 而 tauri build 自己就会编译——同一份代码编了两遍，每次多花 2 分半。
# 而且 `--no-bundle` 根本不是有效参数：它把一行正常的 Info 写到 stderr，
# PowerShell 当成致命错误（NativeCommandError），脚本于是静默回退，又白跑一遍。
#
# 现在：tauri build 一次到位（编译 + 打包 + 签名），输出写进日志文件。
# 不用 `2>&1 | Out-Null`——那是把 stderr 变成 PowerShell 错误记录的元凶。
Write-Host '  首次编译 Rust 需要几分钟；之后增量编译通常几十秒…' -ForegroundColor DarkGray

$logDir = 'dist-installers'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$buildLog = Join-Path $logDir "build-$appVersion.log"

try {
  # **用 cmd /c 做重定向，不要用 PowerShell 的 `*>` 或 `2>&1 |`。**
  #
  # Windows PowerShell 5.1 有个老毛病：只要原生命令往 stderr 写东西，
  # 就会被包装成 NativeCommandError，配合 `$ErrorActionPreference='Stop'`
  # 直接抛异常——而 tauri 往 stderr 写的是正常的 Info 行，不是错误。
  #
  # 交给 cmd 做重定向，PowerShell 只看退出码，问题消失。
  # 日志路径用短路径（8.3）避免空格带来的引号嵌套——workdir 里没有空格时
  # cmd 也不需要额外处理。
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  cmd /c "pnpm --filter @opencoxswain/shell exec tauri build 1> `"$buildLog`" 2>&1"
  $bundleExit = $LASTEXITCODE
  $ErrorActionPreference = $oldPref
}
catch {
  $bundleExit = 1
  Add-Content -Path $buildLog -Value "`n[PowerShell] $($_.Exception.Message)"
}

if ($bundleExit -ne 0) {
  Write-Host ''
  Write-Host '  最近 30 行构建日志：' -ForegroundColor DarkGray
  Get-Content $buildLog -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  Fail '安装包生成失败。' "完整日志：$buildLog"
}
Write-Ok '编译与打包完成'

# 有签名时顺手生成更新清单，发布到 GitHub Releases 需要它。
$sigFiles = Get-ChildItem 'apps/shell/src-tauri/target/release/bundle/nsis' -Filter *.sig -ErrorAction SilentlyContinue
if ($sigFiles) {
  node scripts/make-latest-json.mjs | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Ok '已生成 latest.json（自动更新清单）' }
}

# ---------------------------------------------------------------------------
# 6. 找产物
# ---------------------------------------------------------------------------
Write-Step '产物'
$exe = 'apps/shell/src-tauri/target/release/opencoxswain.exe'
$bundleDir = 'apps/shell/src-tauri/target/release/bundle/nsis'

if (Test-Path $exe) {
  $size = [Math]::Round((Get-Item $exe).Length / 1MB, 1)
  Write-Ok "可执行体：$exe（$size MB）"
}

# ---------------------------------------------------------------------------
# 归档到 dist-installers/
# ---------------------------------------------------------------------------
# 为什么归档：bundle/nsis 在 target/ 里，而 target/ 是 Cargo 的临时区——
# 一次 cargo clean 或者手工清理，历史安装包就全没了（已经发生过一次：
# 0.113.2~0.117.0 那 19 个包只剩签名，exe 全丢）。
#
# 逻辑放在 scripts/archive-installer.mjs 里，不在这里手写：
# 那个脚本能单独跑（1 秒验证，不用重跑 6 分钟出包），也能被测试。
$bundleDir = 'apps/shell/src-tauri/target/release/bundle/nsis'
$installer = Join-Path $bundleDir "OpenCoxswain_${appVersion}_x64-setup.exe"

if (Test-Path $bundleDir) {
  Write-Step '归档安装包'
  node scripts/archive-installer.mjs $appVersion
  if ($LASTEXITCODE -ne 0) {
    # 归档失败不阻断出包——包本身已经产出了，只是少一份副本
    Write-Warn2 '归档未完成（不影响本次出包），见上面的输出。'
  }

  if (Test-Path $installer) {
    $size = [Math]::Round((Get-Item $installer).Length / 1MB, 1)
    Write-Ok "安装包：$((Resolve-Path $installer).Path)（$size MB）"
    Write-Ok "归档副本：$((Resolve-Path 'dist-installers').Path)"
  }
  Start-Process explorer.exe (Resolve-Path 'dist-installers').Path
}

Write-Host ""
Write-Host '✓ 打包完成' -ForegroundColor Green
Write-Host ''
Write-Host '安装前请确认已设置模型密钥（运行时需要）：' -ForegroundColor DarkGray
Write-Host '  setx OPENCOXSWAIN_LLM_API_KEY "sk-..."' -ForegroundColor DarkGray
Write-Host ''
