# OpenCoxswain 项目现状（v0.48.1）

> 本文档是**当前状态的完整快照**，覆盖项目的方方面面。
> 写于 2026-11-12，**2026-11-13 更新到 v0.48.1**。
>
> 如果你只想快速上手，看 [README](../README.md)；
> 想继续开发，看 [roadmap](roadmap.md) 和 [architecture](architecture.md)；
> 想了解本文档没覆盖的历史细节，看 [docs 索引](README.md)。

---

## 目录

1. [这是什么](#1-这是什么)
2. [四层结构与核心机制](#2-四层结构与核心机制)
3. [功能清单：已经能做什么](#3-功能清单已经能做什么)
4. [项目结构：每一处代码在哪、管什么](#4-项目结构每一处代码在哪管什么)
5. [数据模型](#5-数据模型)
6. [HTTP API 全清单](#6-http-api-全清单)
7. [配置与环境变量](#7-配置与环境变量)
8. [安全设计](#8-安全设计)
9. [测试体系](#9-测试体系)
10. [构建与发布](#10-构建与发布)
11. [技术决策记录](#11-技术决策记录)
12. [踩过的坑（真实记录）](#12-踩过的坑真实记录)
13. [已知限制与技术债](#13-已知限制与技术债)
14. [还没做的](#14-还没做的)
15. [常用命令速查](#15-常用命令速查)

---

## 1. 这是什么

**OpenCoxswain（舵手）** 是一个**本地优先的 AI 开发助理**。

你用自然语言说要做什么，它派多个 Agent去干活，边干边向你汇报。

### 一句话定位

> 不是"更聪明的补全"，是**能替你跑腿、但你始终能拍板的助手**。

### 三条设计底线

| 底线 | 含义 | 体现在哪 |
| --- | --- | --- |
| **本地优先** | 代码不出你的机器 | 所有执行都在本地，只有模型调用走网络 |
| **人拍板** | 不可逆的事你说了算 | 危险动作审批、验收复核、定时只提醒 |
| **可追溯** | 出事能查清它做了什么 | 副作用台账、完整会话轨迹、验收结论 |

### 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript（运行时/界面）+ Rust（桌面壳） | Node 生态成熟，Rust 用于系统集成 |
| 运行时依赖 | **零** | 不依赖任何第三方包（有测试守着） |
| 界面 | React 18 + 手写 CSS | 无 UI 框架依赖 |
| 存储 | SQLite（`node:sqlite` 内置） | 不用装数据库，单文件 |
| 桌面 | Tauri 2 | 比 Electron 小得多（安装包 24MB vs 数百 MB） |
| 模型 | OpenAI 兼容端点 | 可换 DeepSeek / 其它 |

### 规模

```
apps/runtime   98 文件  23858 行   产品本体（含 src/test）
apps/web       65 文件  14535 行   工作台界面（含 styles.css 与 src/test）
apps/shell      3 文件    993 行   Tauri 桌面壳（src-tauri 的 .rs）
packages/core  23 文件   2015 行   legacy 内核（部分复用）
────────────────────────────────────
测试          843 条（运行时 584 + 界面 259）
提交          119 个
```

> 行数口径：按换行符计的文件总行数（含空行与注释，与 `wc -l` 一致）；文件数 = 各目录 `src` 下的源文件数（含 `src/test`）。

---

## 2. 四层结构与核心机制

### 2.1 四个角色

```
A 用户
  │  用自然语言说话
  ▼
B Supervisor ── 只在"你有多个项目、不知道进哪个"时路由
  │
  ▼
C Assistant ── 每个项目一个，**常驻会话**
  │  派活 / 汇报 / 判断冲突
  ▼
D Agent ──── 临时工，干完就结算
```

### 2.2 主推流程

```
1. 打开项目          → C 恢复上次的对话
2. 对 C 说"把登录页重构一下"
3. C 判断：这是新任务，可并行
4. C 派 D1、D2、D3 同时开工
5. 谁先完成，C 立刻汇报谁（不等其它）
6. D 卡住了 → C 自己推一把，或问你
7. 你可以继续发话，不打断 C
8. D 干完 → 系统独立复核 → 台账留痕
```

### 2.3 核心机制一览

| 机制 | 做什么 | 为什么这么做 |
| --- | --- | --- |
| **C 常驻** | 一个项目一个 `assistantSessionId` | 关掉软件再打开，C 记得之前聊过什么 |
| **连发不打断** | 消息进 Inbox 双队列（`next` / `step`） | 你说话时 C 还在干活，不该被阻塞 |
| **并行 + 写域互斥** | 只读任务随便并行；写任务按目录加锁 | 三个人同时改同一个文件必然冲突 |
| **先完成先汇报** | 每个 D 结算立刻交给 C | 等最慢的那个会让人以为卡住了 |
| **卡点三分类** | 可重试 / 环境问题 / 需你决定 | 只有第三类才该打扰你 |
| **关窗口不退出** | 点 × 只是隐藏到托盘 | 关个窗口就杀掉正在跑的活儿，不能接受 |
| **单实例锁** | 第二次双击唤回已有窗口 | 两个实例抢同一个端口和数据库 |

### 2.4 为什么 C 不直接干活

因为**反馈延迟**。一个 D 跑 5 分钟没动静，你不知道它在想还是在卡；
换成 C 立刻回一句"我派了三个Agent，先做登录页"，你就安心了。

C 的价值不是"更聪明"，是**让你知道现在什么情况**。

---

## 3. 功能清单：已经能做什么

### 3.1 核心能力

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 对 Assistant 说话派活 | ✅ | 自然语言，自动判断能否并行 |
| D 多路并行 | ✅ | 只读任务不互斥；写任务按写域加锁 |
| 先完成先汇报 | ✅ | 同一批完成的会去抖合并成一条 |
| Agent 可续聊 | ✅ | 点开某个 D 的会话，带着原上下文继续追问 |
| 关软件再打开 | ✅ | C 和 D 的历史都在，从断点继续 |
| B 路由 | ✅ | 项目多了不知道进哪个时，B 给依据或转交原话 |

### 3.2 可信性（线 A）

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 运行指标 | ✅ | 轮次 / 步数 / token / 吞吐 / 缓存命中 / 上下文占用 |
| 用量止损 | ✅ | 单任务 / 每日 token 上限，超了**真停** |
| 危险动作审批 | ✅ | 删除 / 推送 / 发布 / 付款 / 外发，**执行前**拦住 |
| 验收复核 | ✅ | `command` / `diff` / `human` 三类，系统自己验 |
| 副作用台账 | ✅ | 改了哪些文件、跑了哪些命令，全部留痕 |

### 3.3 好用（线 B）

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 记忆写入门槛 | ✅ | 拒绝临时指令、模糊偏好、密钥 |
| 记忆自动提炼 | ✅ | 从对话提炼，**必须你采纳才生效** |
| 记忆管理 | ✅ | 能看见记住了什么，能删单条 |
| 任务模板 | ✅ | 五类，套用只预填，**不自动派活** |
| 定时建议 | ✅ | 到点只提醒，**不自动开工** |
| 界面细节 | ✅ | 消息复制/重发、Agent搜索、回到底部 |

### 3.4 入口与分发（线 C）

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 手机通道（Telegram） | ✅ | 手机发的话 = 对 Assistant 说的话 |
| 自动更新 | ✅ | 签名校验；界面只提示不擅自下载 |
| 单实例锁 | ✅ | 第二次双击唤回窗口 |
| 托盘 | ✅ | 关窗口不退出 |
| 扩展口 | ✅ | 丢个 JS 文件就能自定义拦截与观察 |

### 3.5 安全

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 本机访问令牌 | ✅ | API 需要 Bearer token |
| CORS 白名单 | ✅ | 只允许本地界面自己的来源 |
| 密钥加密 | ✅ | Windows DPAPI，拷到别的机器解不开 |

---

## 4. 项目结构：每一处代码在哪、管什么

```
OpenCoxswain/
├── apps/
│   ├── runtime/          ← 产品本体（自研运行时）
│   ├── web/              ← 工作台界面
│   ├── shell/            ← Tauri 桌面壳
│   ├── daemon/           ← legacy（旧路线，不演进）
│   └── desktop/          ← legacy（旧路线，不演进）
├── packages/
│   ├── core/             ← legacy 内核（部分逻辑已移植）
│   ├── memory/           ← legacy 记忆包
│   ├── adapters/         ← legacy 适配器
│   ├── shared/           ← legacy 共享类型
│   ├── plugin-api/       ← legacy 插件接口
│   └── dsh-bao/          ← 已冻结，仅作设计参考
├── docs/                 ← 文档
├── scripts/              ← 构建与发布脚本
└── build-app.cmd/.ps1    ← 一键出包
```

### 4.1 `apps/runtime` —— 产品本体

按职责分 19 个模块：

| 目录 | 文件 | 职责 |
| --- | --- | --- |
| `assistant/` | 2 | **C** 的提示词与会话管理（含冲突判定） |
| `executor/` | 3 | **D** 的执行循环、工具集、写域闸门、运行器 |
| `global/` | 1 | **B** 的路由逻辑 |
| `inbox/` | 1 | 消息队列（`next` / `step` 双队列） |
| `session/` | 1 | LLM 工具调用循环（最底层，C 和 D 共用） |
| `llm/` | 3 | 模型客户端、设置存储、密钥加密客户端 |
| `store/` | 2 | `Store` 接口 + 内存/SQLite 两套实现 |
| `server/` | 3 | HTTP/SSE 服务、事件总线、访问令牌 |
| `memory/` | 4 | 写入门槛、检索、Markdown 存储、自动提炼 |
| `security/` | 4 | 危险动作分类、审批、副作用台账 |
| `acceptance/` | 2 | 验收标准解析、系统独立复核 |
| `cost/` | 2 | 运行指标、用量止损 |
| `templates/` | 1 | 五类任务模板 |
| `schedules/` | 2 | 定时建议与持久化 |
| `capabilities/` | 1 | **能力接口层**（纯类型，架构边界） |
| `extensions/` | 1 | geek 扩展口（加载与调用） |
| `im/` | 3 | Telegram 客户端、桥接、配置 |
| `update/` | 1 | 更新检查结果读取 |
| `test/` | 27 | 测试文件 |

### 4.2 关键文件逐个说明

#### `apps/runtime/src/orchestrator.ts`（1474 行）

**总调度**。C 和 D 的所有协调逻辑在这里：

- `openProject()` — 打开/新建项目，恢复 C 会话
- `userSays()` — 用户对 Assistant 说话（入队即返回，不阻塞）
- `spawn()` — C 派活：判断冲突、建记录、后台跑
- `runExecutorBackground()` — D 的执行编排
- `userSaysToExecutor()` — 用户直接对 D 追问
- `cancel()` / `recover()` — 取消与重启恢复
- `applyTemplate()` / `checkSchedules()` — 模板与定时

> ⚠️ 这是最大的单文件，T1 技术债已拆过一轮（运行逻辑搬到 `executor/runner.ts`），
> 但仍有优化空间。

#### `apps/runtime/src/executor/runner.ts`

**D 的运行器**。从 orchestrator 拆出来，只管"把 D 跑起来"：

- 首轮运行（`runExecutorOnce`）
- 续聊运行（`resumeExecutorOnce`）
- 工具轨迹记录（`traceHandler`）
- 上下文提取（`priorMessagesFrom`）

**首轮和续聊共用同一套装配**——这样"续聊要不要记账/走审批"不会有人再漏。

#### `apps/runtime/src/executor/gate.ts`

**写域闸门**。决定哪些 D 能同时跑：

```
只读任务        → 永不冲突
写任务 A + 写任务 B → 写域相交才冲突
未声明写域      → 按最保守处理
```

#### `apps/runtime/src/security/approval.ts`

**危险动作审批**。三条硬规则：

1. 执行前冻结，不是执行后通知
2. 超时自动拒绝（默认 10 分钟），不永远挂着
3. 拒绝原因回灌给模型

#### `apps/runtime/src/security/ledger.ts`

**副作用台账**。执行前落 `pending`，执行后结算：

```
fs.write  → 写文件（可补偿，去重）
fs.delete → 删文件（可补偿，去重）
proc.exec → 执行命令（不可补偿，不去重）
net.send  → 对外发送（不可补偿，去重）
```

#### `apps/runtime/src/capabilities/index.ts`

**架构边界**。五类能力的纯类型契约：

```ts
ExecutorCapability     谁来干活
MemoryCapability       记住什么
NotificationCapability 怎么告诉用户
ModelCapability        用谁思考
GuardCapability        什么不许做
```

**这个文件不许 import 任何具体实现**，有测试守着。
将来要上插件系统，只需实现新适配器。

### 4.3 `apps/web` —— 工作台界面

```
src/
├── App.tsx                主应用（路由与状态）
├── api.ts                 API 客户端（含令牌）
├── state.ts               状态管理（快照 + 增量合并）
├── metrics.ts             运行指标格式化
├── styles.css             全部样式
├── components/
│   ├── Sidebar.tsx        左侧导航（B + 工作区树）
│   ├── Conversation.tsx   与 C 的对话
│   ├── ExecutorChat.tsx   D 的轨迹与续聊
│   ├── GlobalAssistant.tsx B 的界面
│   ├── ApprovalPanel.tsx  危险动作审批条
│   ├── MemoryReview.tsx   记忆候选与已生效记忆
│   ├── TemplatePicker.tsx 任务模板选择
│   ├── UpdateBanner.tsx   更新提示
│   ├── MessageActions.tsx 消息复制/重发
│   ├── matching.ts        筛选逻辑（纯函数，可测）
│   ├── useAutoScroll.ts   滚动跟随
│   ├── Markdown.tsx       手写 Markdown 渲染
│   ├── OpenProjectDialog.tsx
│   └── SettingsDialog.tsx
└── test/                  界面测试
```

**布局对齐主流 Agent 软件**：

```
┌─────────────┬──────────────────────────┐
│ ◎ Supervisor B │                          │
│ ＋ 添加项目  │                          │
│─────────────│        主区              │
│ 工作区       │   （点文件夹 = 对 Assistant 说话）│
│ ▾ 项目 A     │   （点条目   = 看某个 D）│
│   · 对话1    │                          │
│   · 对话2    │                          │
└─────────────┴──────────────────────────┘
```

### 4.4 `apps/shell` —— 桌面壳

Tauri 2 + Rust，职责很窄：

| 文件 | 职责 |
| --- | --- |
| `main.rs` | 拉起运行时、开窗口、托盘、单实例、DPAPI 命令 |
| `dpapi.rs` | Windows DPAPI 加解密封装 |
| `secret_service.rs` | 给运行时用的极小加密服务（回环端口 47901） |

**壳只做系统集成，不含业务逻辑。**

### 4.5 `packages/` —— legacy

这些是**旧路线**的代码，不删、不演进，但部分逻辑已被移植：

| 包 | 状态 | 已移植的部分 |
| --- | --- | --- |
| `core` | 保留 | 验收策略、副作用台账、授权模型 |
| `memory` | 保留 | 写入门槛、检索排序 |
| `adapters` | 保留 | 危险动作分类 |
| `shared` | 保留 | 类型定义 |
| `plugin-api` | 保留 | 插件接口设计 |
| `dsh-bao` | **冻结** | 仅作设计参考，不依赖 |

> **为什么留着**：里面有些实现经过真实验证，
> 需要时是"移植"而不是"重写"。

---

## 5. 数据模型

### 5.1 存储位置

```
~/.opencoxswain/
├── runtime.db          SQLite 主库
├── llm.json            模型密钥（DPAPI 加密）
├── token               API 访问令牌
├── im.json             Telegram 配置
├── schedules.json      定时任务配置
├── memory/             记忆（Markdown）
│   ├── user_profile.md
│   └── projects/<key>/project_memory.md
└── extensions/         用户扩展（可选）
```

### 5.2 SQLite 表（schema v7）

| 表 | 存什么 | 关键字段 |
| --- | --- | --- |
| `project` | 项目 | `root_path`、`assistant_session_id`、`token_guard` |
| `session` | 会话（C 的 / D 的） | `kind`、`parent_session_id`、`system_prompt` |
| `message` | 消息 | `role`、`content`、`source`（含 `internal:` 前缀） |
| `executor` | Agent | `access`、`write_scope`、`metrics`、`criteria`、`acceptance` |
| `turn` | 轮次 | `judged`（判定结果，可审计） |
| `report` | 汇报 | `kind`、`needs_user` |
| `approval` | 危险动作审批 | `category`、`evidence`、`status`、`expires_at` |
| `side_effect` | 副作用台账 | `kind`、`target`、`state`、`idempotency_key` |
| `memory_candidate` | 记忆候选 | `kind`、`scope`、`status` |

### 5.3 迁移

用 `PRAGMA user_version` 管理，当前 v7。历史迁移：

```
v1 → v2  executor 加 access 列（区分只读/读写）
v2 → v3  executor 加运行指标列；project 加 token_guard
v4 → v5  executor 加验收字段（criteria / policy / acceptance）
v5 → v6  新增 side_effect 表
v6 → v7  新增 memory_candidate 表
```

**每次迁移都验证过老库能平滑升级**，不丢数据。

### 5.4 双存储实现

`Store` 是一个接口，两套实现：

| 实现 | 用途 |
| --- | --- |
| `MemoryStore` | 测试、快速验证 |
| `SqliteStore` | 生产 |

**同一套断言跑两套实现**（`store.test.ts`），保证行为一致。

---

## 6. HTTP API 全清单

### 6.1 鉴权

所有 `/api/*` 请求（**健康检查除外**）都需要：

```
Authorization: Bearer <token>
```

令牌在 `~/.opencoxswain/token`，首次启动自动生成。

### 6.2 端点

#### 基础

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（**不需要令牌**） |
| GET | `/api/events` | SSE 事件流（支持 `?after=<seq>` 断线重放） |
| GET | `/api/settings` | 模型配置状态（含 `storage: encrypted/plaintext`） |
| POST | `/api/settings` | 保存模型密钥 |
| DELETE | `/api/settings` | 清除模型密钥 |
| GET | `/api/update` | 更新检查结果 |

#### 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 打开/新建项目 |
| GET | `/api/projects/:id` | 项目详情（含Agent与汇报） |
| POST | `/api/projects/:id/say` | 对 Assistant 说话 |
| POST | `/api/projects/:id/stop` | 停止当前这轮 |
| GET | `/api/projects/:id/messages` | 会话消息 |
| GET | `/api/projects/:id/reports` | 汇报列表 |
| GET | `/api/projects/:id/usage` | 用量统计 |
| POST | `/api/projects/:id/guard` | 设置用量止损上限 |
| GET | `/api/projects/:id/memories` | 记忆候选 |
| POST | `/api/projects/:id/memories` | 触发记忆提炼 |
| GET | `/api/projects/:id/memory-list` | 已生效的记忆 |
| POST | `/api/projects/:id/memory/:scope/:id/forget` | 删除一条记忆 |

#### Agent

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/executors/:id` | Agent详情 |
| GET | `/api/executors/:id/messages` | 完整轨迹 |
| GET | `/api/executors/:id/effects` | 副作用台账 |
| POST | `/api/executors/:id/say` | 直接对 D 追问 |
| POST | `/api/executors/:id/cancel` | 取消Agent |

#### 审批

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/approvals` | 待审批列表 |
| POST | `/api/approvals/:id/approve` | 批准 |
| POST | `/api/approvals/:id/reject` | 拒绝 |

#### 记忆

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/memories/:id/accept` | 采纳候选 |
| POST | `/api/memories/:id/dismiss` | 忽略候选 |

#### 模板与定时

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/templates` | 模板列表 |
| POST | `/api/templates/:id/apply` | 套用模板（**只生成草稿**） |
| GET | `/api/schedules` | 定时列表 |
| POST | `/api/schedules` | 保存定时 |
| POST | `/api/schedules/check` | 手动检查（**只产建议**） |

#### Supervisor B

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/route` | B 路由：给依据或转交原话 |
| GET | `/api/route/brief` | 项目概览（供 B 判断） |
| POST | `/api/handoff` | 转交原话到指定项目 |

#### IM

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/im` | IM 配置状态（**不回传 token**） |
| POST | `/api/im` | 保存配置（先验证 token） |
| DELETE | `/api/im` | 清除配置 |
| POST | `/api/im/start` | 启动通道 |
| POST | `/api/im/stop` | 停止通道 |

### 6.3 SSE 事件类型

```
assistant_text        C 的回复
executor_started      D 开始运行
executor_queued       D 进入队列
executor_settled      D 结算
turn_judged           需求判定（可审计）
report                汇报
approval_requested    危险动作待审批
acceptance            验收结果
memory_candidates     记忆候选
```

**断线重放**：客户端带 `?after=<seq>`，服务端补发错过的事件。
错过太多会收到 `gap` 事件，客户端应重新拉快照。

---

## 7. 配置与环境变量

### 7.1 全部环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCOXSWAIN_LLM_API_KEY` | 空 | 模型密钥（也接受 `DEEPSEEK_API_KEY`） |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | 模型名 |
| `OPENCOXSWAIN_LLM_FILE` | `~/.opencoxswain/llm.json` | 密钥文件位置 |
| `OPENCOXSWAIN_DB` | `~/.opencoxswain/runtime.db` | SQLite 库 |
| `OPENCOXSWAIN_MEMORY` | `~/.opencoxswain/memory` | 记忆目录 |
| `OPENCOXSWAIN_PORT` | `47900` | HTTP 端口 |
| `OPENCOXSWAIN_TOKEN` | 自动生成 | API 访问令牌 |
| `OPENCOXSWAIN_TOKEN_FILE` | `~/.opencoxswain/token` | 令牌文件位置 |
| `OPENCOXSWAIN_IM_FILE` | `~/.opencoxswain/im.json` | IM 配置位置 |
| `OPENCOXSWAIN_TELEGRAM_TOKEN` | 空 | Telegram bot token（优先于配置文件） |
| `OPENCOXSWAIN_NODE_BIN` | 空 | 桌面壳用的 node 路径 |
| `OPENCOXSWAIN_SECRET_URL` | 壳注入 | DPAPI 服务地址 |
| `OPENCOXSWAIN_SECRET_TOKEN` | 壳注入 | DPAPI 服务令牌 |
| `TAURI_SIGNING_PRIVATE_KEY` | 空 | **只用于发版**：更新签名私钥 |

### 7.2 优先级

```
环境变量 > 配置文件 > 默认值
```

**注意**：模型密钥用环境变量时，文件里的密钥**仍会被读取一次**
（为了触发明文→密文的迁移）。

---

## 8. 安全设计

### 8.1 威胁模型

假设的对手是**同机器上的其它程序**和**你浏览的网页**，
不是能提权的攻击者。

### 8.2 措施

| 层面 | 措施 | 防什么 |
| --- | --- | --- |
| 网络 | 只监听 `127.0.0.1` | 外部网络访问 |
| API | Bearer 令牌 | 同机其它程序调用 |
| 浏览器 | CORS 白名单（不用 `*`） | 恶意网页跨源读 API |
| 密钥 | Windows DPAPI | 密钥文件被拷走 |
| 动作 | 危险动作审批 | 不可逆操作 |
| 用量 | token 止损 | 失控烧额度 |
| 执行 | 只读任务硬拦截写入和删改命令 | 只读任务偷写文件 |
| 扩展 | 扩展不能绕过写域/审批/验收 | 扩展被当成后门 |

### 8.3 不做的

| 不做 | 原因 |
| --- | --- |
| 多用户 / 权限分级 | 本地单用户工具，没有"用户"概念 |
| 网络传输加密 | 只走回环，不上网 |
| 密钥分片存储 | 威胁模型里没有"能提权的攻击者" |

### 8.4 已知的边界

**扩展跑在运行时进程里，和主程序同权。**

一个恶意扩展可以读你的文件、让程序崩溃。
所以：**只放你信任的扩展**，就像只 `npm install` 你信任的包。

---

## 9. 测试体系

### 9.1 规模

```
运行时 305 条（26 个文件）
界面    38 条（4 个文件）
────────────────────
合计   343 条
```

### 9.2 逐文件说明

| 文件 | 条数 | 覆盖什么 |
| --- | --- | --- |
| `server.test.ts` | 18 | HTTP 接口、SSE 首帧、断线重放、CORS、超大 body |
| `ledger.test.ts` | 18 | **执行前落 pending**、续聊也记账、被拒绝记 rejected |
| `memory.test.ts` | 17 | 写入门槛、分词排序、Markdown 往返 |
| `acceptance.test.ts` | 17 | **D 说完成但没改动 → 判失败**、复核命令过闸门 |
| `guard.test.ts` | 16 | **用量止损真的能停**、指标格式化、未报告≠0 |
| `extract.test.ts` | 16 | **临时指令进不了候选**、候选不自动生效 |
| `runtime.test.ts` | 15 | 主推流程、并行、排队、先完成先报、连发 |
| `parallel.test.ts` | 15 | **只读任务真正并行**、写任务仍互斥 |
| `store.test.ts` | 14 | **同一套断言跑内存与 SQLite** |
| `approval.test.ts` | 14 | **未批准的动作真的没发生**、超时自动拒绝 |
| `extensions.test.ts` | 13 | **扩展真能拦住工具**、不能绕过写域 |
| `static.test.ts` | 10 | 静态资源、路径穿越、缓存策略回归 |
| `llm-settings.test.ts` | 9 | 密钥保管、环境变量优先、立即生效 |
| `auth.test.ts` | 9 | **真实 HTTP**：跨源拒绝、无令牌 401 |
| `path.test.ts` | 7 | 盘符根归一化（`D:\` → `d:/`） |
| `templates.test.ts` | 20 | **套用模板后没有Agent**、定时只产建议 |
| `token.test.ts` | 20 | 令牌生成校验、CORS 白名单、注入转义（XSS） |
| `dchat.test.ts` | 5 | 三条只读并行、Agent 可续聊 |
| `purity.test.ts` | 5 | 内部通知不进对话流 |
| `boundary.test.ts` | 4 | **零依赖、不依赖 DSH、接口层不碰实现** |
| `recover.test.ts` | 3 | 关掉再打开，C 带着对话继续 |
| `port.test.ts` | 1 | 端口占用给可读提示 |
| `probe.test.ts` | 1 | SSE 首帧延迟回归守卫 |
| `secret.test.ts` | 10 | 密钥加密落盘、旧明文迁移 |
| `update.test.ts` | 11 | 版本比较、更新结果读取 |
| `im.test.ts` | 17 | **IM 走同一条 userSays**、审批复用同一记录 |

### 9.3 测试原则

| 原则 | 做法 |
| --- | --- |
| **不 mock 掉关键链路** | 用真实 HTTP 请求、真实文件系统、真实 SQLite |
| **负面场景必须测** | 篡改签名、越界写入、恶意来源、超时 |
| **回归测试写清症状** | 注释里写明"曾经因为没 flushHeaders 卡 15s" |
| **架构靠测试守** | `boundary.test.ts` 检查 import，不靠自觉 |
| **不假装测过** | 需要 GUI 的（滚动、剪贴板）明确写"未验证" |

### 9.4 测试用的假模型

`test/mock-llm.ts` — 脚本化的假 LLM，**不需要网络**：

```ts
new MockLlmClient((request) => {
  if (!isExecutorTurn(request)) return { text: '好的' };
  return { tool: 'write_file', args: { path: 'a.txt', content: 'A' } };
}, { tokensIn: 600, tokensOut: 200 });
```

可以控制返回内容**和 token 用量**（用于测止损）。

---

## 10. 构建与发布

### 10.1 版本号管理

**唯一来源是根 `package.json`**，其余 5 处自动同步：

```bash
node scripts/version.mjs show          # 看当前版本
node scripts/version.mjs bump patch    # 0.14.0 → 0.14.1（修缺陷）
node scripts/version.mjs bump minor    # 0.14.0 → 0.15.0（加功能）
node scripts/version.mjs bump major    # 0.14.0 → 1.0.0（不兼容）
```

`pnpm build` 和 `build-app.cmd` 都会先自动同步。

### 10.2 构建

```bash
pnpm install
pnpm build            # 编译运行时 + 界面
pnpm test             # 843 条测试
pnpm app:build        # 出安装包
```

产物：`apps/shell/src-tauri/target/release/bundle/nsis/`

```
OpenCoxswain_<版本>_x64-setup.exe       安装包（约 24MB）
OpenCoxswain_<版本>_x64-setup.exe.sig   签名
latest.json                             更新清单
```

### 10.3 发布

```bash
node --use-system-ca scripts/publish-release.mjs --dry-run   # 先检查
node --use-system-ca scripts/publish-release.mjs             # 真正发布
```

脚本会：检查产物齐全 → 校验清单版本 → 创建 Release → 上传三个文件。

**注意**：脚本用 `git` 凭据里的 GitHub token，需要 `repo` scope。

### 10.4 自动更新的两个签名概念

| | 是什么 | 我们的状态 |
| --- | --- | --- |
| **更新包签名**（minisign） | 保证"更新包是你发的" | ✅ 已做 |
| **Windows 代码签名** | 保证"Windows 信任这个发布者" | ❌ 未做（需要 EV 证书） |

所以用户首次安装会看到 SmartScreen 警告，需要点「更多信息 → 仍要运行」。
已在 README 里写明。

### 10.5 当前发布状态

```
https://github.com/Syntax-Liu/OpenCoxswain/releases
  v0.48.1  ← 最新
  v0.48.0
  v0.47.0
```

**仓库是私有的**，所以：
- Release 需要登录 GitHub 才能下载
- 应用内自动更新拉不到 `latest.json`（匿名 404）

**开源后改一行 `endpoints` 就能用。**

---

## 11. 技术决策记录

### 11.1 为什么完全自研，不做 dsh 插件

**背景**：最初做过一版 dsh 插件（`packages/dsh-bao`），后来放弃了。

**原因**：两套抽象并行漂移。插件层要适配 dsh 的类型和行为，
自己的设计又被 dsh 的模型限制。改一处要同时考虑两边。

**结论**：产品本体必须自主。dsh-bao 已冻结，只作设计参考。

### 11.2 为什么现在不做插件系统

**DSH 的「万物皆插件」建在 Cordis 上**（依赖注入、服务隔离、生命周期）。
它这么做是因为要支撑插件市场、第三方贡献。

**我们不一样**：能力都是自己写的、一个人维护、没有第三方。

现在上框架 = 为一个还不存在的问题付复杂度代价，还会动摇刚做完的可信性。

**做法**：先切边界（`capabilities/`），成本极低。
将来要上插件系统，只需写新适配器，业务代码不动。

**什么时候才真的上**：

- [ ] 有第三方想贡献能力
- [ ] 同一能力需要多种实现并存
- [ ] 需要运行时热插拔

### 11.3 为什么运行时不引任何第三方依赖

**因为这是"自研"的实质**。

如果运行时依赖一堆包，"自主可控"就是空话。
有测试（`boundary.test.ts`）守着 `dependencies` 必须为空数组。

**代价**：一些轮子要自己写（Markdown 渲染、base64、minisign 验签）。
**收益**：升级不担心供应链，安全边界清晰。

### 11.4 为什么密钥加密放在 Rust 壳里

DPAPI 是 Win32 API。Node 调它要引原生模块，会破坏零依赖。

**做法**：壳实现 DPAPI，通过一个回环端口 + 强制令牌的极小 HTTP 接口暴露给运行时。

**为什么不用"自己加密文件"**：那个密钥也在同一台机器上，
同用户进程照样能读。那是混淆，不是加密。

### 11.5 为什么托盘做成"关窗口不退出"

关掉窗口会杀掉运行时，正在跑的Agent全部中断。
用户点个 × 就丢掉任务，这个体验不能接受。

**折中**：点 × 隐藏到托盘，D 继续跑；真正退出走托盘菜单。
菜单项文字直接写「退出（会停止正在跑的Agent）」——让你在点之前就知道代价。

### 11.6 为什么模板和定时都不能自动执行

**因为"人拍板"是产品前提。**

一旦到点自己跑起来，半夜自动改代码、自动提交，
你第二天打开会看到完全不认识的状态。

**代码结构上杜绝**：定时模块**没有"自动执行"这个 API**；
模板返回值的 `requiresConfirmation` 是字面量类型 `true`。

### 11.7 为什么不做计费

**最初设计是错的。** 原计划按可配置单价折算美元并做预算硬停。

**用户指出**：不同模型单价不同且随时调整，软件离线无法获取实时价格，
而且用户本来就能在服务商后台看到真实账单。**估算出来的金额只会误导人。**

**改成**：只呈现模型自己报告的真实数字（轮次、步数、token、吞吐、缓存命中），
外加一条纯 token 的止损线（防止失控烧额度，不涉及金额）。

### 11.8 为什么先做 Telegram 而不是飞书

Telegram：API 极简、不用企业认证、长轮询天然适合本地软件（不用公网 IP）。
飞书：要企业自建应用 + 公网回调，重得多。

---

## 12. 踩过的坑（真实记录）

这些是**真实发生过**的问题，不是假设。写下来是为了不再犯。

### 12.1 应用装了打不开：EISDIR

**现象**：双击图标没反应。

**原因**：Tauri `resource_dir()` 返回 verbatim 路径 `\\?\D:\...`，Node 解析不了。

**修复**：`normalize()` 里剥掉 `\\?\` 前缀。

**衍生坑**：`D:\` 被归一化成 `d:`（少了斜杠），又修了一次成 `d:/`。

### 12.2 升级后界面还是旧的

**现象**：修了 bug 重新打包，界面还是老样子。

**原因**：静态资源设了 `Cache-Control: immutable`（一年）。

**修复**：改成 `no-cache` + `ETag` 协商缓存。

**教训**：本地应用的静态资源没必要强缓存。

### 12.3 SSE 连上后卡 15 秒

**现象**：客户端 `fetch()` 能连上，但迟迟收不到事件。

**原因**：没有 `res.flushHeaders()`，响应头没立刻发出去。

**修复**：加上 flush，并写了回归测试钉死。

### 12.4 只读任务被串行执行

**原因**：`scopesConflict` 把"空写域"和"只读"混为一谈。

**修复**：引入 `ExecutorAccess` 三态（`readwrite` / `readonly` / 未声明），
约定 `["readonly"]` 表示只读。

### 12.5 续聊漏记副作用台账

**现象**：通过续聊改的文件，不出现在"改动了什么"里。

**原因**：续聊代码是从首轮复制的，**复制时漏掉了 ledger 那一行**。

**修复**：把运行逻辑抽到 `executor/runner.ts`，两处共用同一套装配。

**这条是靠"真跑一遍 + 看日志"才发现的**，光看测试全绿发现不了。

### 12.6 验签一直失败（误判成密钥问题）

**现象**：本地验签永远不过，以为私钥和公钥不配对。

**实际原因**：minisign 的算法标识 `ED`（大写）表示**预哈希模式**——
要先对内容算 BLAKE2b-512，再对哈希做 Ed25519。用 `Ed` 的方式直接验内容永远失败。

**修复**：按算法标识选择验证方式。

**教训**：报错信息像"签名不匹配"，实际是验证方式错了。

### 12.7 DPAPI 服务令牌永远匹配不上

**现象**：`缺少或错误的令牌`，看起来像配置没传进去。

**实际原因**：解析 HTTP header 时用了**转小写后的行**取令牌值，
令牌被整体转成小写，正确的令牌也匹配不上。

**修复**：从原始行取值，只用小写判断 header 名。

### 12.8 环境变量用户永远留着明文密钥

**原因**：`resolve()` 走环境变量分支时直接返回，从不读文件，
所以明文→密文的迁移永远不触发。

**修复**：即使走环境变量也触发一次 `read()`。

### 12.9 Release tag 指针错位

**现象**：`v0.14.0` 的 tag 指向了 0.13.0 的提交。

**原因**：多行提交消息被 PowerShell 解析错误导致提交失败，
但发布脚本没检查就发了 Release，此时 `main` 还停在旧提交。

**修复**：`git tag -f` 重新指向，强制推送。

**教训**：发布前应检查工作区是否干净、提交是否成功。

### 12.10 扩展的多个回调互相覆盖

**现象**：示例扩展里的"本机策略"静默失效。

**原因**：实现用单槽存储，第二个 `beforeTool` 覆盖第一个。

**修复**：改成数组累加。

**这条是"真跑了一遍示例"才发现的**。

---

## 13. 已知限制与技术债

### 13.1 限制（设计取舍，不是缺陷）

| 限制 | 说明 |
| --- | --- |
| 单用户 | 没有账号体系，本地工具不需要 |
| 不支持 GPU / 本地模型 | 走 OpenAI 兼容 HTTP 端点 |
| 不做增量更新 | 每次下载完整安装包（24MB），可接受 |
| 无代码签名 | 有 SmartScreen 警告，已文档说明 |

### 13.2 技术债

| # | 问题 | 影响 | 状态 |
| --- | --- | --- | --- |
| ~~T1~~ | `orchestrator.ts` 过大 | 难读难改 | **已拆一轮**（v0.9.0 拆分：1449 → 1430 行；现 1474 行），仍可继续优化 |
| ~~T2~~ | 运行时无鉴权 | **跨源漏洞** | ✅ 已修（令牌 + CORS 白名单） |
| ~~T3~~ | 密钥明文存储 | 同机可读 | ✅ 已修（DPAPI） |
| T4 | 无代码签名 | SmartScreen 警告 | 已文档说明，暂不处理 |
| T5 | 界面无虚拟滚动 | 几百条消息会卡 | 真卡了再做 |
| T6 | 数据库无清理 | 长期使用会变大 | 需要时加归档 |

### 13.3 未验证的部分（诚实说明）

| 项 | 为什么没验证 |
| --- | --- |
| 从 GitHub 真实下载并安装更新 | 仓库私有，匿名拉不到 `latest.json` |
| 真实 Telegram 网络连通 | 需要你的 bot token；测试全部脱网用假 fetch |
| 界面滚动行为、剪贴板 | 需要浏览器环境，没做自动化 |

**这些我都没说"测过了"。**

---

## 14. 还没做的

按价值排序：

| # | 事项 | 价值 |
| --- | --- | --- |
| 1 | **真实使用反馈** | 比再猜着加功能有价值得多 |
| 2 | 飞书通道 | Telegram 之外的第二个入口 |
| 3 | 多模型支持 | 现在只能用 OpenAI 兼容端点 |
| 4 | 记忆自动提炼定时触发 | 现在要手动点 |
| 5 | 界面虚拟滚动 | 消息极多时才需要 |
| 6 | 数据归档/清理 | 长期使用后需要 |
| 7 | 代码签名证书 | 消除 SmartScreen 警告 |

---

## 15. 常用命令速查

### 开发

```bash
pnpm install              # 装依赖
pnpm build                # 编译
pnpm test                 # 跑全部测试
pnpm typecheck            # 类型检查
pnpm runtime --project D:/work/app --serve --static apps/web/dist
```

### 出包与发布

```bash
pnpm version:minor                        # 升版本号
pnpm app:build                            # 出安装包
node scripts/make-latest-json.mjs         # 生成更新清单
node --use-system-ca scripts/publish-release.mjs --dry-run
node --use-system-ca scripts/publish-release.mjs
```

### 验证

```bash
# 更新链路（先起本地服务器）
pnpm release:serve --port 47800
pnpm release:verify

# Rust 侧
cargo check --manifest-path apps/shell/src-tauri/Cargo.toml
cargo test  --manifest-path apps/shell/src-tauri/Cargo.toml dpapi
```

### 调试

```bash
# 日志位置
%LOCALAPPDATA%\OpenCoxswain\logs\runtime.log

# 数据库
sqlite3 %USERPROFILE%\.opencoxswain\runtime.db

# 看看令牌
type %USERPROFILE%\.opencoxswain\token
```

---

## 附：一句话总结

**一个能并行干活、但你始终能拍板的本地 AI 助理。**
代码不出你的机器，不可逆的事要你点头，改了什么全部留痕。
