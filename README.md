# OpenCoxswain · 舵手

**本地优先的四层 AI 助理**。你只对 Assistant 说话，它把活派给 Agent 并行干，谁先完成先报谁。

> **完全自研**：不依赖 dsh、TRAE 或任何外部 Agent 框架。只依赖 Node.js 与一个 OpenAI 兼容的模型端点。

> ⚠️ **早期项目（0.x），可以日常用，但别指望它不出错。**
>
> 已知没做完的：
> - **方案审批的「批准后自动推进」还没接**——现在批准方案不会自动往下走
> - 自动更新依赖仓库公开（目前在私有仓库下 `latest.json` 取不到）
> - 只在 Windows 上验证过，Linux / macOS 没有 CI
>
> 怎么跑起来、怎么参与见 [CONTRIBUTING.md](CONTRIBUTING.md)。
> 安全相关问题见 [SECURITY.md](SECURITY.md)，**不要开公开 issue**。

## 四层结构

```
User ─────────→ Supervisor   跨项目统筹：全局视图、跨项目冲突、优先级裁决、跨项目记忆
  │
  └─→ Assistant              一项目一常驻会话，项目的主人（主推入口）
        │
        └─→ Agent            一事一 Agent，直接改代码，可被追问
```

> 命名以 [docs/glossary.md](docs/glossary.md) 为准：
> **User / Supervisor / Assistant / Agent**（文案一律首字母大写）。

## 主推流程

```
打开项目 → 对 Assistant 说："把登录页重构一下"
  └─ Assistant 立刻回一句（不阻塞），然后派 Agent
你又发（Assistant 还没答完）："顺便看看导出为什么卡住"
  └─ 消息排队，不打断；Assistant 判断两件事不冲突 → 再派一个 Agent，并行
Agent#1 先完成 → Assistant 立刻汇报 Agent#1，不等 Agent#2
Agent#2 卡住 → Assistant 按卡点分类自己先推进；真要问你时只问一件
```

## 快速开始

```bash
pnpm install
pnpm build

# 1. 命令行
export OPENCOXSWAIN_LLM_API_KEY=sk-...
pnpm runtime --project D:/work/my-app

# 2. 带界面
node apps/runtime/dist/cli.js --project D:/work/my-app --serve --static apps/web/dist
# 打开 http://127.0.0.1:47900

# 3. 桌面应用
pnpm app:build        # 产物在 apps/shell/src-tauri/target/release/bundle/nsis/
```

## 安装时 Windows 会拦一下（正常现象）

安装包**没有购买代码签名证书**，所以首次运行 Windows 会显示：

> Windows 已保护你的电脑 —— Microsoft Defender SmartScreen 阻止了无法识别的应用启动

这是「**未知发布者**」，不是检测到病毒。点：

```
更多信息  →  仍要运行
```

如果你不放心，可以自己从源码构建（`pnpm app:build`），产物与你下载的一致。

> 自动更新包的**签名**是有的——那个签名保证"更新是你装的这个应用发出的"，
> 与 Windows 是否信任发布者是两件事。详见 [docs/release.md](docs/release.md)。

## 目录

| 路径 | 说明 |
| --- | --- |
| `apps/runtime` | **运行时（产品本体）**：四层结构的全部业务逻辑 + HTTP/SSE 服务 |
| `apps/web` | 工作台界面：项目 → 对 Assistant 说话 → 看 Agent 进展 |
| `apps/shell` | Tauri 2 桌面壳：拉起运行时并加载其界面 |
| `apps/daemon`、`apps/desktop` | **legacy**（旧的自研路线），不删、不再演进 |
| `packages/{shared,core,adapters,memory,plugin-api}` | legacy 内核与业务包，按需抽取复用 |
| `packages/dsh-bao` | **已冻结**的 dsh 插件，仅作设计参考 |
| `docs/` | 方案、决策与实测记录，入口见 [docs/README.md](docs/README.md) |
| `docs/project-status.md` | **项目全景快照**：四层结构、功能清单、代码结构、数据模型、API、决策记录、踩坑史 |

## 关键机制

| 机制 | 说明 |
| --- | --- |
| **Assistant 常驻** | 一项目一 `assistantSessionId`；关掉软件再打开，Assistant 带着原对话继续 |
| **关窗口不退出** | 点 × 只是隐藏到托盘，Agent 继续跑；真正退出走托盘菜单「退出」 |
| **任务模板** | 修缺陷 / 加功能 / 写文档 / 重构 / 调研五类，套用只预填，**不自动派活** |
| **定时建议** | 到点只提醒，不自动开工——人拍板是产品前提 |
| **连发不打断** | 新消息进 Inbox 排队，当前这轮跑完才被看到 |
| **真正的并行** | 只读任务（`writeScope: ["readonly"]`）之间**永远不排队**；写任务按写域相交互斥 |
| **Agent 可续聊** | 点开任何一个 Agent，看它的完整轨迹并带上下文继续追问 |
| **先完成先报** | 每个 Agent 独立结算、独立汇报，互不等待 |
| **卡点三分类** | 可自行重试 / 环境问题 / 需用户决定 —— Assistant 据此决定要不要打扰你 |
| **记忆** | 本地 Markdown（全局 + 项目两级），写入有门槛：拒绝临时指令、模糊偏好、密钥 |
| **运行指标** | 轮次 / 步数 / token / 吞吐 / 缓存命中 / 上下文占用。**不做计费**——单价随模型变动，估算只会误导 |
| **用量止损** | 可设单任务与每日 token 上限，超了**真停**，防止失控 Agent 烧光额度 |
| **危险动作审批** | 删除 / 推送 / 发布 / 付款 / 对外发送这类**不可逆**动作，**执行前**拦下等你拍板；超时自动拒绝 |
| **SSE 可重放** | 断线重连带 `?after=` 补发；错过太多会明确告知并重拉快照 |

## 测试

```bash
pnpm test        # 运行时 865 + 界面 66 = 931 条（不需要浏览器、不需要网络）
pnpm e2e         # 真实 Chrome 跑 14 条交互用例（需要先 build + 起服务）
pnpm typecheck
pnpm app:check   # Rust 壳编译检查
```

**为什么分两层**：

- `pnpm test` 跑纯逻辑与渲染契约，秒级完成，CI 里跑这个。
- `pnpm e2e` 在真实 Chrome 里跑交互。为什么要单独一层：
  受控组件（input / select / textarea）在 jsdom / happy-dom + React 18 下
  **不可靠**——受控值更新后同步读到的 DOM 会与组件状态不一致，
  写出来的测试时过时不过。真实浏览器没有这个问题。

e2e 需要先构建并起服务：

```bash
pnpm build
node apps/runtime/dist/cli.js --serve --static apps/web/dist --port 47910
pnpm e2e        # OCX_URL 默认指向 127.0.0.1:47910
```

运行时测试用**脚本化假模型**驱动，不需要网络，其中包含：
- 端到端：用户 → Assistant → Agent → **Agent 真的在临时目录写出文件** → Assistant 汇报
- 并行：**三条只读任务同时进入 running，零排队**（回归过"逐条串行"的缺陷）
- 续聊：Agent 完成后追问，断言第二轮请求里**确实带着第一轮的目标与结论**
- 存储：**同一套断言跑内存与 SQLite**，证明换后端不改行为
- 重启恢复：模拟两次进程启动，断言第二次的上下文里**确实有第一次的对话**
- 静态资源：路径穿越防护、缓存策略回归

## 安全

| 机制 | 说明 |
| --- | --- |
| **只监听 127.0.0.1** | 外部网络访问不到 |
| **本机访问令牌** | API 需要 `Authorization: Bearer <token>`；令牌在 `~/.opencoxswain/token`，首次启动自动生成 |
| **密钥加密（DPAPI）** | 模型密钥以 Windows DPAPI 密文存储，由当前用户账户派生，**拷到别的机器或别的用户下都解不开** |
| **CORS 白名单** | 只允许本地界面自己的来源。**别的网页调不动这个 API** |
| **危险动作审批** | 删除 / 推送 / 发布 / 付款 / 对外发送，执行前必须你点 |
| **用量止损** | token 超上限直接停 |
| **副作用台账** | 改了什么、跑了什么，全部有记录 |

> 为什么需要令牌：运行时虽然只监听本机，但**同机上的任何程序都能访问它**。
> 早期版本的 CORS 是 `*` 且无鉴权，意味着你浏览器里打开的任何网页
> 都能跨源读取本地 API 并派活执行命令。已修复。

## 环境变量
| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCOXSWAIN_LLM_API_KEY` | 空 | 模型密钥（也接受 `DEEPSEEK_API_KEY`）；也可在界面设置里填 |
| `OPENCOXSWAIN_LLM_FILE` | `~/.opencoxswain/llm.json` | 界面保存的密钥文件（**环境变量优先**） |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | 模型 |
| `OPENCOXSWAIN_DB` | `~/.opencoxswain/runtime.db` | SQLite 库 |
| `OPENCOXSWAIN_MEMORY` | `~/.opencoxswain/memory` | 记忆目录 |
| `OPENCOXSWAIN_NODE_BIN` | 空 | 桌面壳启动运行时用的 node |
| `OPENCOXSWAIN_PORT` | `47900` | 运行时 HTTP 端口（端口被占用时改这个） |
| `OPENCOXSWAIN_TOKEN` | 自动生成 | 本机 API 访问令牌；一般不用手动设 |
| `OPENCOXSWAIN_IM_FILE` | `~/.opencoxswain/im.json` | 手机通道（Telegram）配置 |
| `OPENCOXSWAIN_TELEGRAM_TOKEN` | 空 | 手机通道 bot token（优先于配置文件） |
| `TAURI_SIGNING_PRIVATE_KEY` | 空 | **只用于发版构建**：自动更新签名私钥。见 [docs/release.md](docs/release.md) |


## 发布

见 [docs/release.md](docs/release.md)（密钥保管、发版流程、SmartScreen 说明）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
