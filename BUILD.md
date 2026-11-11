# 出包说明

## 一键出包

**双击仓库根目录的 `build-app.cmd`** 即可。

它会依次完成：

1. 检查工具链（Node ≥ 22 / pnpm / Rust / MSVC）
2. 安装依赖
3. 构建运行时 + 界面
4. 摊平资源到桌面壳
5. 编译 Rust 并生成 NSIS 安装包
6. 自动打开产物目录

产物位置：

```
apps/shell/src-tauri/target/release/bundle/nsis/OpenCoxswain_<版本>_x64-setup.exe
```

## 命令行用法

```powershell
# 完整出包
.\build-app.ps1

# 只构建、不打包（快速验证，约 1 分钟）
.\build-app.ps1 -BuildOnly

# 跳过依赖安装
.\build-app.ps1 -SkipInstall
```

也可以用 pnpm 脚本：

```bash
pnpm app:build     # 等价于完整出包
pnpm app:check     # 只做 Rust 编译检查
```

## 前置要求

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 22 | 运行时用内置 `node:sqlite`，无需编译原生模块 |
| pnpm | `corepack enable` 或 `npm i -g pnpm` |
| Rust stable | https://rustup.rs/ ，需选 MSVC 工具链 |
| VS Build Tools | 含 MSVC 与 Windows SDK（Tauri 打包必需） |
| WebView2 | Windows 11 自带；Win10 需装运行时 |

脚本会在开始前检查前四项，缺了直接给出可读提示，不会编译到一半才失败。

## 装完之后

1. 双击安装包安装（currentUser 模式，不需要管理员权限）
2. 从开始菜单启动 OpenCoxswain
3. **首次启动会让你填 API Key**（也可以提前设 `OPENCOXSWAIN_LLM_API_KEY` 环境变量）
4. 点「打开项目」选一个目录，然后直接对项目助理说话

密钥保存在 `~/.opencoxswain/llm.json`，只在删除或覆盖时改变。

## 安装包里有什么

```
OpenCoxswain.exe
resources/
  staging/
    node/node.exe        自带的 Node 运行时（目标机器不需要装 Node）
    runtime/             运行时（cli.js 及其模块，零外部依赖）
    web/                 工作台界面
```

## 运行时行为

- 监听 `127.0.0.1:47900`（仅本机）
- 数据库 `~/.opencoxswain/runtime.db`
- 记忆 `~/.opencoxswain/memory/`
- 日志 `%LOCALAPPDATA%\OpenCoxswain\logs\runtime.log`

关闭窗口时壳会按**进程树**结束运行时，不留孤儿进程。

## 常见问题

**打包时报 linker 错误**
缺 MSVC 或 Windows SDK。装 VS Build Tools 时勾选「使用 C++ 的桌面开发」。

**首次编译很慢**
Rust 要编译整个 Tauri 依赖树，首次 5–15 分钟属正常。之后增量编译约 1 分钟。

**`spawn EPERM` 或文件写入被拒**
杀毒软件或系统策略拦截。把仓库目录加入白名单后重试。

**装完双击没反应**
看 `%LOCALAPPDATA%\OpenCoxswain\logs\runtime.log`。常见原因是找不到 Node 或运行时入口。

**界面改了但看着没变**
已经处理过，但值得知道原因：早期版本给静态资源设了 `immutable` 长缓存，
桌面应用升级后 webview 仍加载旧 JS。现在：

- 运行时只发 `Cache-Control: no-cache` + `ETag`（协商缓存，内容变了必然拿到新版）；
- 窗口加载的 URL 带版本号 `/?v=<版本>`；
- `stage-shell.mjs` 会**清空** staging 与 Tauri 打包副本，不会堆积历史产物。

如果仍然看到旧界面，删掉 `apps/shell/src-tauri/target/release/staging` 后重新出包。
