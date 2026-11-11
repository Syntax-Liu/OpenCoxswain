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
Write-Step '打包桌面应用（首次会编译 Rust，可能需要几分钟）'
Write-Host '  过程较长属于正常现象，请耐心等待…' -ForegroundColor DarkGray

Push-Location 'apps/shell/src-tauri'
cargo build --release --offline
$cargoExit = $LASTEXITCODE
Pop-Location

if ($cargoExit -ne 0) {
  # 离线失败时可能是本地没缓存某些 crate，再联网试一次。
  Write-Warn2 '离线编译失败，尝试联网重新编译…'
  Push-Location 'apps/shell/src-tauri'
  cargo build --release
  $cargoExit = $LASTEXITCODE
  Pop-Location
  if ($cargoExit -ne 0) { Fail 'Rust release 编译失败。' '看上面的 error 行；常见原因是缺 MSVC 或 Windows SDK。' }
}
Write-Ok '可执行体编译完成'

Write-Step '生成 NSIS 安装包'
# 自动更新需要签名：没有私钥也能构建，只是不产出 .sig / latest.json。
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

pnpm --filter @opencoxswain/shell exec tauri build --no-bundle 2>&1 | Out-Null
$bundleExit = $LASTEXITCODE
if ($bundleExit -ne 0) {
  # --no-bundle 不支持时回退到标准打包
  pnpm --filter @opencoxswain/shell exec tauri build
  $bundleExit = $LASTEXITCODE
}
if ($bundleExit -ne 0) { Fail '安装包生成失败。' '看上面的输出；可能是 NSIS 下载失败（需要网络）。' }

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
if (Test-Path $bundleDir) {
  Get-ChildItem $bundleDir -Filter *.exe | ForEach-Object {
    $size = [Math]::Round($_.Length / 1MB, 1)
    Write-Ok "安装包：$($_.FullName)（$size MB）"
  }
  Start-Process explorer.exe $bundleDir
}

Write-Host ""
Write-Host '✓ 打包完成' -ForegroundColor Green
Write-Host ''
Write-Host '安装前请确认已设置模型密钥（运行时需要）：' -ForegroundColor DarkGray
Write-Host '  setx OPENCOXSWAIN_LLM_API_KEY "sk-..."' -ForegroundColor DarkGray
Write-Host ''
