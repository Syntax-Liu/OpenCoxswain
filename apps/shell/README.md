# OpenCoxswain 桌面壳

把自研运行时与工作台打成**双击即用**的 Windows 桌面应用。

## 它做什么

```
双击图标
  └─ 壳启动 Node（优先用安装包自带的运行时）
       └─ node runtime/dist/cli.js --serve --port 47900 --static <工作台目录>
            └─ 同一端口既服务 /api/*（REST + SSE）又服务工作台静态文件
  └─ 壳开窗口，加载 http://127.0.0.1:47900/
```

**为什么让运行时同时服务界面**：
- 界面与 API **同源**，没有 CORS、没有第二个端口；
- 退出时只需结束**一个**子进程树。

## 沿用的既有做法

这些来自 legacy 桌面壳（v0.13–v0.30）踩过的坑，全部保留：

| 做法 | 原因 |
| --- | --- |
| 优先用安装包自带的 Node，找不到才回退系统 node | 目标机器不需要预装 Node |
| **先建窗口，再后台等运行时** | 运行时慢或起不来时，用户该看到界面里的提示，而不是双击后毫无反应 |
| 退出时 `taskkill /T /F` 按**进程树**强杀 | 否则运行时拉起的子进程变成孤儿 |
| `CREATE_NO_WINDOW` | 不弹出黑色控制台 |
| panic hook 写日志 | 崩溃可诊断 |

日志位置：`%LOCALAPPDATA%\OpenCoxswain\logs\runtime.log`

## 已踩过的坑（都已在代码里处理）

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| Tauri 的 `resource_dir()` 返回 verbatim 路径 | `\\?\D:\...\cli.js`，Node 解析失败报 `EISDIR: lstat 'D:'`，应用起不来 | `normalize()` 剥掉 `\\?\` 与 `\\?\UNC\` 前缀 |
| 静态资源设了长缓存 | 升级后 webview 仍加载旧 JS，"修了却没生效" | 运行时改 `no-cache` + `ETag`；窗口 URL 带 `?v=<版本>` |
| staging 累积历史产物 | 旧哈希的 JS/CSS 一直跟着发版走 | `stage-shell.mjs` 清空 staging 与 Tauri 打包副本 |

## 目录

```
src-tauri/
  Cargo.toml
  tauri.conf.json     窗口、打包目标、资源目录
  build.rs
  src/main.rs         拉起运行时 + 开窗口 + 退出清理
staging/              打包时生成（不提交）
  runtime/            运行时 dist
  web/                工作台构建产物
  node/node.exe       可选，自带 Node
```

## 构建

```bash
# 1. 构建运行时与界面
pnpm --filter @opencoxswain/runtime build
pnpm --filter @opencoxswain/web build

# 2. 摊平到壳的资源目录
pnpm --filter @opencoxswain/shell stage

# 3. 打包（需要 Rust 与 MSVC）
pnpm --filter @opencoxswain/shell build
```

产物：`apps/shell/src-tauri/target/release/bundle/nsis/*.exe`

## 开发态

设置 `OPENCOXSWAIN_RUNTIME_ENTRY` 指向 `apps/runtime/dist/cli.js`，
壳会优先用它；否则回退到 `resource_dir/staging/runtime/cli.js`，
再回退到源码树里的 `apps/runtime/dist/cli.js`。

## 待办

| 项 | 说明 |
| --- | --- |
| 自动更新 | legacy `apps/desktop` 有完整实现可移植；需要发布用的签名公钥（私钥绝不能进仓库） |
| 单实例锁 | 避免重复启动多个运行时抢 47900 端口 |
| 托盘图标与「关闭到托盘」 | 当前关闭即退出 |

架构与能力边界见 [`docs/architecture.md`](../../docs/architecture.md)。
