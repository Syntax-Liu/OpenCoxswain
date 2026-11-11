# OpenCoxswain · 舵手

**本地优先的四层 AI 助理**。你只对项目助理说话，它把活派给执行者并行干，谁先完成先报谁。

> **完全自研**：不依赖 dsh、TRAE 或任何外部 Agent 框架。只依赖 Node.js 与一个 OpenAI 兼容的模型端点。

## 四层结构

```
A 用户 ──┬─→ B 全局助理   跨项目路由：判断该找哪个 C，转交原话，绝不代 C 汇报
         ├─→ C 项目助理   一项目一常驻会话，项目的主人（主推入口）
         └─→ D 执行者     一事一 D，直接改代码，可被追问
```

## 主推流程

```
打开项目 → 对 C 说："把登录页重构一下"
  └─ C 立刻回一句（不阻塞），然后派 D
你又发（C 还没答完）："顺便看看导出为什么卡住"
  └─ 消息排队，不打断；C 判断两件事不冲突 → 再派一个 D，并行
D#1 先完成 → C 立刻汇报 D#1，不等 D#2
D#2 卡住 → C 按卡点分类自己先推进；真要问你时只问一件
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

## 目录

| 路径 | 说明 |
| --- | --- |
| `apps/runtime` | **运行时（产品本体）**：四层结构的全部业务逻辑 + HTTP/SSE 服务 |
| `apps/web` | 工作台界面：项目 → 对 C 说话 → 看 D 进展 |
| `apps/shell` | Tauri 2 桌面壳：拉起运行时并加载其界面 |
| `apps/daemon`、`apps/desktop` | **legacy**（旧的自研路线），不删、不再演进 |
| `packages/{shared,core,adapters,memory,plugin-api}` | legacy 内核与业务包，按需抽取复用 |
| `packages/dsh-bao` | **已冻结**的 dsh 插件，仅作设计参考 |
| `docs/` | 方案、决策与实测记录，入口见 [docs/README.md](docs/README.md) |

## 关键机制

| 机制 | 说明 |
| --- | --- |
| **C 常驻** | 一项目一 `assistantSessionId`；关掉软件再打开，C 带着原对话继续 |
| **连发不打断** | 新消息进 Inbox 排队，当前这轮跑完才被看到 |
| **真正的并行** | 只读任务（`writeScope: ["readonly"]`）之间**永远不排队**；写任务按写域相交互斥 |
| **D 可续聊** | 点开任何一个执行者，看它的完整轨迹并带上下文继续追问 |
| **先完成先报** | 每个 D 独立结算、独立汇报，互不等待 |
| **卡点三分类** | 可自行重试 / 环境问题 / 需用户决定 —— C 据此决定要不要打扰你 |
| **记忆** | 本地 Markdown（全局 + 项目两级），写入有门槛：拒绝临时指令、模糊偏好、密钥 |
| **运行指标** | 轮次 / 步数 / token / 吞吐 / 缓存命中 / 上下文占用。**不做计费**——单价随模型变动，估算只会误导 |
| **用量止损** | 可设单任务与每日 token 上限，超了**真停**，防止失控执行者烧光额度 |
| **危险动作审批** | 删除 / 推送 / 发布 / 付款 / 对外发送这类**不可逆**动作，**执行前**拦下等你拍板；超时自动拒绝 |
| **SSE 可重放** | 断线重连带 `?after=` 补发；错过太多会明确告知并重拉快照 |

## 测试

```bash
pnpm test        # 运行时 149 + 界面 28 = 177 条
pnpm typecheck
pnpm app:check   # Rust 壳编译检查
```

运行时测试用**脚本化假模型**驱动，不需要网络，其中包含：
- 端到端：用户 → C → D → **D 真的在临时目录写出文件** → C 汇报
- 并行：**三条只读任务同时进入 running，零排队**（回归过"逐条串行"的缺陷）
- 续聊：D 完成后追问，断言第二轮请求里**确实带着第一轮的目标与结论**
- 存储：**同一套断言跑内存与 SQLite**，证明换后端不改行为
- 重启恢复：模拟两次进程启动，断言第二次的上下文里**确实有第一次的对话**
- 静态资源：路径穿越防护、缓存策略回归

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

## 后续方向

见 [docs/roadmap.md](docs/roadmap.md)。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
