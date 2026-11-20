# OpenCoxswain

<p align="center">
  <strong>本地优先的编码助理，四层 Agent 结构。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

你只对 Assistant 说话。它把活拆给多个 Agent 并行执行，谁先完成先报谁。

> **状态：0.x，早期项目。** 在 Windows 上可以日常使用，但会有粗糙的地方。

## 运作方式

```
User ────────→ Supervisor   跨项目统筹：全局视图、跨项目冲突、优先级裁决
  │
  └─→ Assistant             一项目一常驻会话，项目的主入口
        │
        └─→ Agent           一事一 Agent，直接改代码，可被追问
```

| 层 | 视野 | 生命周期 |
| --- | --- | --- |
| **Supervisor** | 全部项目 | 全局，只在后端 |
| **Assistant** | 单个项目 | 常驻，重启后仍在 |
| **Agent** | 单个任务 | 按任务创建，可继续追问 |

命名以 [docs/glossary.md](docs/glossary.md) 为准。层名一律首字母大写。

## 安装

目前没有公开发布的安装包，从源码构建。

需要 **Node.js ≥ 22** 与 **pnpm 10**。只有构建桌面安装包时才需要 Rust 1.77+。

```bash
pnpm install
pnpm build
```

## 快速开始

```bash
# 命令行
export OPENCOXSWAIN_LLM_API_KEY=sk-...
pnpm runtime --project D:/work/my-app

# 带界面
node apps/runtime/dist/cli.js --project D:/work/my-app --serve --static apps/web/dist
# 打开 http://127.0.0.1:47900

# 桌面应用
pnpm app:build     # 产物在 apps/shell/src-tauri/target/release/bundle/nsis/
```

运行时在同一个端口上同时提供 API 与界面，不需要第二个服务，也不需要配 CORS。

## 功能

- **Assistant 常驻。** 一项目一会话。关掉应用再打开，对话还在。
- **并行执行，独立汇报。** 每个 Agent 单独结算、单独汇报，互不等待。
- **连发不打断。** 新消息进收件箱排队，当前这轮跑完再读。
- **只读任务不排队。** `writeScope: ["readonly"]` 的任务与任何任务并行；写任务在写域相交时互斥。
- **可以追问 Agent。** 点开任意 Agent 查看完整轨迹，带上下文继续追问。
- **卡点分类。** Assistant 把卡住的 Agent 归为可重试、环境问题、需要你决定三类，之后才打扰你。
- **记忆。** 本地 Markdown，分全局与项目两级。拒绝临时指令、模糊偏好与密钥。
- **用量止损。** 可设单任务与每日 token 上限，到达上限真的停止。
- **不可逆动作需审批。** 删除、推送、发布、付款、对外发送在执行前等你拍板，超时默认拒绝。
- **SSE 可重放。** 断线后用 `?after=` 补发错过的事件；积压过多时明确告知并重拉快照。
- **任务模板。** 修缺陷、加功能、写文档、重构、调研。模板只预填，不会自动派活。

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCOXSWAIN_LLM_API_KEY` | 空 | 模型密钥，也接受 `DEEPSEEK_API_KEY`；可在界面里设置 |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | 模型名 |
| `OPENCOXSWAIN_LLM_FILE` | `~/.opencoxswain/llm.json` | 界面写入的密钥文件，环境变量优先 |
| `OPENCOXSWAIN_DB` | `~/.opencoxswain/runtime.db` | SQLite 数据库 |
| `OPENCOXSWAIN_MEMORY` | `~/.opencoxswain/memory` | 记忆目录 |
| `OPENCOXSWAIN_PORT` | `47900` | HTTP 端口 |
| `OPENCOXSWAIN_TOKEN` | 自动生成 | 本机 API 令牌，一般不用设 |
| `OPENCOXSWAIN_IM_FILE` | `~/.opencoxswain/im.json` | Telegram 通道配置 |
| `OPENCOXSWAIN_TELEGRAM_TOKEN` | 空 | Telegram bot token，优先于配置文件 |
| `TAURI_SIGNING_PRIVATE_KEY` | 空 | 仅发版构建使用，见 [docs/release.md](docs/release.md) |

## 安全

运行时只绑定 `127.0.0.1`，每次 API 调用都要求 `Authorization: Bearer <token>`。令牌在首次启动时生成，存放在 `~/.opencoxswain/token`。

模型密钥用 Windows DPAPI 加密，密钥由当前用户账户派生。拷贝走的密钥文件在别的机器或别的账户下解不开。

CORS 只允许本地界面来源。你打开的其它网页调不动这个 API。

> 早期版本用的是 `Access-Control-Allow-Origin: *` 且没有鉴权，浏览器里任何页面都能调用本地 API 派活执行命令。当前版本会拒绝这些调用。

安全问题请私下报告，见 [SECURITY.md](SECURITY.md)。不要开公开 issue。

## Windows 桌面应用

安装包没有代码签名，首次运行 SmartScreen 会显示「Windows 已保护你的电脑」。选择 **更多信息 → 仍要运行**。更新包的签名是另一回事，它只证明更新来自这个应用。

## 开发

```bash
pnpm test        # 单元测试，不需要浏览器与网络
pnpm e2e         # 对运行中的服务跑浏览器交互测试
pnpm typecheck
pnpm app:check   # Rust 壳编译检查
```

e2e 需要先构建并启动服务：

```bash
pnpm build
node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47910
pnpm e2e
```

单元测试由脚本化的假模型驱动，覆盖从用户消息到 Agent 真正写出文件、再由 Assistant 汇报的完整链路，只读任务并行派发且零排队，追问时保留上下文，内存与 SQLite 两种存储行为一致，以及重启后的恢复。

浏览器测试单独成层，因为受控输入（`input`、`select`、`textarea`）在 jsdom / happy-dom 配合 React 18 时行为不可靠，真实浏览器没有这个问题。

代码地图与贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- **方案审批不会自动推进。** 批准方案后还不会自动开始下一步。
- **仅 Windows。** Linux 与 macOS 没有 CI 覆盖。
- **没有公开发版。** 自动更新需要公开的 `latest.json`，目前没有托管。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `apps/runtime` | 运行时：四层结构的全部逻辑，以及 HTTP/SSE 服务 |
| `apps/web` | 工作台界面：选项目、对 Assistant 说话、看 Agent 进展 |
| `apps/shell` | Tauri 2 桌面壳 |
| `apps/daemon`、`apps/desktop` | legacy，保留但不再演进 |
| `packages/{shared,core,adapters,memory,plugin-api}` | legacy 内核与业务包 |
| `packages/dsh-bao` | 已冻结的 dsh 插件，仅作设计参考 |
| `docs/` | 方案与记录，入口见 [docs/README.md](docs/README.md) |
| `docs/project-status.md` | 项目全景快照：结构、功能、数据模型、API |

## 文档

- [docs/architecture.md](docs/architecture.md)：分层边界与模块划分
- [docs/glossary.md](docs/glossary.md)：代码、文档、界面的命名权威
- [docs/release.md](docs/release.md)：发布与更新流程
- [docs/README.md](docs/README.md)：完整索引

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
