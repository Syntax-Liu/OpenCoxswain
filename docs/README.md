# 文档索引

## 从这里开始

| 想知道什么 | 看哪份 |
| --- | --- |
| **下一步做什么** | [`roadmap.md`](roadmap.md) ← **最新** |
| **我们差在哪** | [competitor-gap.md](competitor-gap.md) ← **竞品调研：7 个子系统的差距** |
| **界面往哪走** | [design-direction.md](design-direction.md) ← **视觉方向方案（待确认）** |
| **改界面之前** | [ui-spec.md](ui-spec.md) ← **界面规范，唯一标准** |
| **术语怎么叫** | [glossary.md](glossary.md) ← **命名的唯一权威来源** |
| **完整了解项目** | [`project-status.md`](project-status.md) ← **全景快照：功能、结构、数据、API、决策、踩坑记录** |
| **架构是怎么定的** | [`architecture.md`](architecture.md)：能力边界、为什么现在不做插件框架 |
| **怎么发版** | [`release.md`](release.md)：自动更新、签名密钥、SmartScreen |
| **想自己定制** | [`extensions.md`](extensions.md)：丢个 JS 文件就能改行为 |
| **竞品格局与差异化定位** | [`competitor-verdict.md`](competitor-verdict.md) ← **权威**（判定谁是真竞品）<br>[`market-scan.md`](market-scan.md)（原始扫描记录） |
| **开源共建该怎么走** | [`open-source-plan.md`](open-source-plan.md)（不盈利前提下的可参与性规划） |
| 当前能做什么、怎么跑 | [`../README.md`](../README.md) |
| 为什么这样设计（四角色） | [`self-developed-plan.md`](self-developed-plan.md) |
| 具体实现细节 | [`../apps/runtime/README.md`](../apps/runtime/README.md)、[`../apps/web/README.md`](../apps/web/README.md) |
| 怎么出安装包 | [`../BUILD.md`](../BUILD.md) |

## 当前方向（2026-11-11 二次修订）：**自研整套软件**

**产品最终形态是完全自研的四层结构软件，不依赖任何外部 Agent 框架（dsh / TRAE 等）。**

```
A User ──┬─→ B Supervisor   跨项目统筹：全局视图、冲突检测、优先级、跨项目记忆
         ├─→ C Assistant   一项目一常驻会话，项目的主人（主推入口）
         └─→ D Agent     一事一 Agent，直接改代码，可追问
```

### 代码现状

| 路径 | 角色 | 状态 |
| --- | --- | --- |
| **`apps/runtime`** | **自研运行时（产品本体）** | ✅ C 常驻 + D 并行（区分只读/读写）+ 先完成先报 + 写域互斥 + 连发不打断 + Agent 可续聊 + SQLite 持久化与重启恢复 + HTTP/SSE + 本地 Markdown 记忆层 + **运行指标与用量止损** + **危险动作审批**。**305 条测试** |
| **`apps/web`** | **工作台界面** | ✅ 左侧导航（文件夹 = C，条目 = D）+ 单页主区；D 轨迹查看与续聊、B 路由界面、Markdown 渲染、**运行指标展示**。**38 条测试** |
| **`apps/shell`** | **桌面壳** | ✅ Tauri 2：拉起运行时、加载其界面、退出按进程树清理、日志落盘。安装包 23.6 MB，自带 Node |
| `packages/dsh-bao` | dsh 插件 | 🔒 **已冻结**为设计参考，不再演进 |
| `apps/daemon`、`apps/desktop` | 自研 daemon + 工作台 + Tauri 壳 | legacy，按需抽取 |
| `packages/{shared,core,adapters,memory,plugin-api}` | 自研内核与业务包 | legacy，按需抽取复用 |

### 怎么跑起来

```bash
# 终端 1：运行时 + HTTP/SSE + 界面静态文件（同源，一个端口）
node apps/runtime/dist/cli.js --serve --static apps/web/dist
# 打开 http://127.0.0.1:47900/

# 终端 2：界面开发服务器（热更新）
pnpm --filter @opencoxswain/web dev     # http://127.0.0.1:5180

# 桌面安装包
双击 build-app.cmd
```

详细说明见 [`apps/runtime/README.md`](../apps/runtime/README.md)、[`apps/web/README.md`](../apps/web/README.md)、[`apps/shell/README.md`](../apps/shell/README.md)、[`BUILD.md`](../BUILD.md)。

### 为什么路线又变了

前一版（2026-11-11 上午）把方向定为"做 dsh 插件"。用户随后明确：**dsh 只作开发期验证，最终产品必须自研整套**。

关键核查结论：legacy `packages/adapters/builtin.ts` **已经是一个完整的 LLM tool-calling 循环**，所以"用 dsh 验证 Agent 行为"是多余的——直接基于内置循环自研更快，也避免两套抽象并行漂移。

### 权威文档

| 文档 | 作用 | 时效性 |
| --- | --- | --- |
| [`roadmap.md`](roadmap.md) | **后续发展方向**：已完成的、待做的、优先级与验收标准 | ✅ 最新 |
| [`project-status.md`](project-status.md) | **项目全景**：四层结构、功能清单、代码结构、数据模型、API、决策记录、踩坑史 | ✅ 最新 |
| [`architecture.md`](architecture.md) | **架构决策**：能力边界、四道防线、何时才上插件框架 | ✅ 最新 |
| [`release.md`](release.md) | **发布与自动更新**：签名密钥保管、发版流程、SmartScreen | ✅ 最新 |
| [`extensions.md`](extensions.md) | **扩展口**：geek 自定义点、能做什么不能做什么 | ✅ 最新 |
| [`self-developed-plan.md`](self-developed-plan.md) | 四角色定义、三条流程、连发机制、分阶段规划 | ⚠️ 设计原则有效，实现细节已按自研调整（见文内状态标注） |
| [`verify/p0-findings.md`](verify/p0-findings.md) | 四个关键假设的实测结论 | ⚠️ 基于 dsh 类型定义；**行为事实仍成立**，但 dsh 已不再作为依赖 |
| [`trae-bao-reference.md`](trae-bao-reference.md) | TRAE 宝官方文档调研摘录（产品参照） | ✅ 仍有效 |

### 已拍板的决策（2026-11-11）

| # | 决策 | 结论 |
| --- | --- | --- |
| **D0** | 产品最终形态 | **自研整套软件**，不依赖 dsh |
| **D1** | B 与 C 之间是否互通 | B 可替用户把**原话**转交给 C，绝不代 C 汇报。B 只有三个能力 |
| **D2** | C 是否允许同时跑多个 D | 允许并行，默认上限 **5**，写域互斥必须同时上线 |
| **D3** | 用户直连 D 后 C 是否知道 | **C 知道** |
| **D4** | C 的汇报节奏 | **谁先完成先报谁**，同一批同时完成合并成一条 |
| **D5** | 关掉软件后 C 的记忆 | **完整恢复**会话 |

## 历史路线（已封存，仍可查阅）

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [`dsh-api-findings.md`](dsh-api-findings.md) | dsh 0.2.2-rc.1 各包 README 原文摘录 | 证据库，仍有效 |
| [`dsh-bao-m0.md`](dsh-bao-m0.md) | dsh 插件 M0 说明 | 已冻结 |
| [`trae-bao-plan.md`](trae-bao-plan.md) | 对标 TRAE 宝的 dsh 插件方案 | 已封存 |
| [`prd/`](prd/) · [`plan.md`](plan.md) · [`plugin-architecture.md`](plugin-architecture.md) · [`super-agent-adoption.md`](super-agent-adoption.md) · [`master-worker-ux.md`](master-worker-ux.md) · [`feasibility-critique-response.md`](feasibility-critique-response.md) · [`questionnaire-*.md`](questionnaire-v2.md) · [`spike-opencode.md`](spike-opencode.md) | 完全自研阶段（v0.1.0 → v0.36.2）的设计与取舍 | 历史档案，可抽取复用 |
