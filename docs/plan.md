# OpenCoxswain 实施计划

> 依据：[OpenCoxswain PRD v0.3](prd/OpenCoxswain-PRD.tex)（同源 [PDF](prd/OpenCoxswain-PRD.pdf)）。
> 本文只记录实施路线与取舍，不重复 PRD 的产品定义。

## 1. 产品核心形态

本地优先的 Windows AI 总管「舵手」：

- **单入口**：用户只与总管对话；总管不读写文件、不跑 shell、不碰 git。
- **规划与执行解耦**：总管产出结构化任务单和 DAG，调度器按依赖、写域、并发和预算派发。
- **员工隔离**：每个任务一个 git worktree、一个独立会话、一套角色工具白名单。
- **状态在代码里**：任务状态机、预算、审批、事件全部落 SQLite，不依赖模型记忆。
- **一切可回放**：每次派单、工具调用、验收都是 append-only 事件。
- **本地优先**：Daemon 只监听 127.0.0.1；代码、日志、密钥默认不出本机。

形态：`Tauri 2 桌面壳 + React 工作台` → `Node/TS 本地 Daemon` → `RuntimeAdapter` → `OpenCode`。Daemon 是产品核心，桌面 App / CLI / IM 都只是入口。

## 2. 技术栈（遵循 PRD，不替换）

| 层 | 选型 | 实施说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 放在最后一阶段接入并构建；本机暂无 Rust/MSVC 工具链，P1/P2 先用浏览器验证同一套 React 工作台。 |
| UI | React 18 + TypeScript + Vite | 不引入组件库，工作台样式手写 CSS，避免额外依赖。 |
| 本地 Daemon | Node 22 + TypeScript | `engines >= 22`；当前验证环境为 Node 24 LTS，仅使用 Node 22 已支持的 API。 |
| 数据库 | SQLite + FTS5 | 使用 Node 内置 `node:sqlite`（Node 22.5+），零原生依赖；已实测 FTS5 可用。 |
| HTTP/事件 | `node:http` + SSE | PRD 允许 WebSocket/SSE；v0 用 SSE，单向事件流足够。 |
| 运行时 | OpenCode（首发） | v0.3.0 已接入桌面版 CLI（`runtime.opencode`，`run --standalone --format json`）；Mock 保留为测试替身。见 [spike-opencode.md](spike-opencode.md)。 |
| 包管理 | pnpm workspace | 与 PRD CI 一致；monorepo。 |
| 测试 | `node:test` | 不引入测试框架，降低依赖。 |
| 校验 | 手写契约校验器 | 按 PRD 附录字段逐项校验，不引入 JSON Schema 运行时依赖。 |
| 密钥 | Windows Credential Manager / DPAPI | v0.3.0 先走环境变量 BYOK，不落明文；P2 迁移到 Credential Manager。 |
| 打包 | NSIS / MSI + Tauri Updater | Phase 2 之后。 |

## 3. 模块划分

```
apps/
  daemon/      # 本地核心：插件内核（生命周期/事件/权限/状态机）+ 内置插件
  desktop/     # React 工作台；UI 面板同样通过注册表插件化
packages/
  shared/      # ID、时间、通用类型、API DTO
  core/        # 任务契约、状态机、DAG、预算、汇总、工具白名单
  adapters/    # RuntimeAdapter 接口 + Mock；后续加 OpenCode
  plugin-api/  # 插件契约：Manifest、PluginContext、服务表、权限
  memory/      # Phase 3（v1）创建：Markdown + FTS5
docs/
  prd/         # PRD 原文（tex + pdf）
  plan.md
  plugin-architecture.md
```

依赖方向：`shared ← core ← adapters ← plugin-api ← daemon`；`desktop → shared`（仅类型/协议）。`memory` 在 v1 才创建，避免空包和死代码。

插件架构（详见 [plugin-architecture.md](plugin-architecture.md)）：内核只保留生命周期、事件总线、权限闸门与任务状态机；存储、worktree、运行时、Planner、调度器、总管、HTTP/SSE、REST API 与 UI 面板都以统一 Manifest + Module 契约注册加载，内置插件与外部插件走同一条加载路径，不保留特权后门。P1 的权限闸门是进程内架构约束，真正的进程/沙箱隔离留到后续阶段。

### 各模块职责

- **shared**：`task_id`/`worker_id` 生成、ISO 时间、API 请求/响应类型、SSE 事件类型。
- **core**：
  - `TaskContract` 类型 + 运行时校验（必填字段、枚举、验收标准 id 唯一、command 必须有 check）。
  - 任务状态机（含用户专属迁移、暂停/恢复、阻塞原因）。
  - DAG：环检测、依赖就绪、写域冲突检测。
  - 预算守卫：70% 警告、100% 硬停。
  - 三块汇总模板生成。
  - 总管工具白名单定义。
- **adapters**：PRD 附录的完整 `RuntimeAdapter` 接口；`MockRuntimeAdapter` 在真实 worktree 里写文件、跑验收命令、产出 diff 与成本，用于离线闭环。
- **daemon**：
  - SQLite 迁移与仓储（projects/tasks/task_edges/workers/runs/events/artifacts/approvals/budgets/model_calls/messages）。
  - Worktree 管理：`git worktree add/remove`，中文/空格路径按参数数组传参，文件锁重试。
  - 调度器：依赖就绪、并发上限（默认 2）、写域互斥、预算检查、状态推进。
  - 总管服务：计划生成（v0.3.0 起 `planner.llm` 可调真实模型，无 Key/失败时回退静态引擎）、审批、汇总、事件广播。
  - HTTP API + SSE；只监听 loopback。
- **desktop**：三栏工作台（项目/任务树、总管对话、员工看板）+ 底部时间线/产物/汇总/花费；首次使用引导。

## 4. 阶段与里程碑

PRD 里程碑为 M0–M4。实际开发拆成可独立验收的 P0–P4，顺序与 PRD 一致。

### P0：可运行纵切与工程骨架（本次）

对应 PRD「下一步」第 1–4 项的最小闭环。

- 复制 PRD、建立 docs/plan.md、monorepo、TypeScript 基线、Apache-2.0、README、git 初始提交。
- core：契约、状态机、DAG、预算、汇总 + 单元测试。
- daemon：SQLite、worktree、调度器、总管编排、HTTP/SSE + 集成测试。
- adapters：`RuntimeAdapter` + `MockRuntimeAdapter`。
- desktop：React 工作台（浏览器可跑）。
- 端到端剧本：创建 demo 仓库 → 建项目 → 说目标 → 出任务单 → 确认开工 → 实施/校验两个员工并行/串行跑 → 三块汇总 → 时间线回放。

**交付物**：`pnpm dev` 可同时起 Daemon 与工作台；一条命令跑通 E2E；事件时间线可导出。

### P1：插件化内核 + 真实执行体（M0 + M1 前半）

- 插件架构落地（已完成，v0.2.0）：按 [plugin-architecture.md](plugin-architecture.md) 把 Mock 运行时、静态 Planner、调度器、总管、存储、worktree、HTTP/SSE、REST API 与工作台面板改为插件；内核只保留生命周期、事件总线、权限与状态机；e2e 全流程保持通过。
- OpenCode Windows spike（已完成，v0.3.0）：桌面版 2.2.6 CLI 的 `run --standalone --format json` 路线实测可用，无需用户 Key；结论与坑记录在 [spike-opencode.md](spike-opencode.md)。
- 实现 `OpenCodeRuntimeAdapter` 插件（已完成，v0.3.0）：`runtime.opencode` 与 Mock 同路径注册；JSONL 映射到 `RuntimeEvent`，每会话隔离 XDG 目录，进程树可终止。
- 接入 LLM Planner（已完成，v0.3.0）：`planner.llm` 使用 OpenAI 兼容端点（默认 DeepSeek），BYO Key 走环境变量；无 Key、超时或解析失败自动回退静态拆分。Key 存入 Credential Manager/DPAPI 仍待 P2。
- 跑通真实仓库的「修夜间模式」剧本；补危险动作人审（delete/push/publish/pay/external_send）。
- Windows 专项：中文/空格路径、长路径、worktree 清理、进程清理。
- Tauri 2 桌面壳放在 P1 最后一步：本机暂无 Rust/MSVC 时不阻塞上述工作，浏览器继续验证同一套 React 工作台。

**交付物**：插件化 Daemon 与工作台；真实 OpenCode 员工；真实 diff 与测试报告；预算硬停；Tauri 安装包（工具链就绪后）。

### P2：v0 收口与内测（M1 后半 + M2）

- DAG 2–5 子任务、写域冲突、顺序合并、冲突转人审。
- 暂停/终止/接管、失败重试矩阵（原员工重试 → 换强模型 → 拆任务 → 问人）。
- 日预算、成本报表、回放导出、崩溃恢复。
- 自用内测，记录「拆错/跑偏/验收失败」案例，反推 v1 记忆优先级。

**交付物**：满足 PRD v0 五条验收剧本；可回放覆盖率 100%。

### P3：v1 记忆 + 完整工作台（M3）

- `packages/memory`：`user_profile.md` / `project_memory.md` / `decisions.md` / `lessons.md` + SQLite FTS5。
- 写入门槛、来源追溯、冲突处理、混合检索（关键词 + 时间衰减；embedding 后置）。
- 记忆检查器、待决策收件箱、DAG 可视化、产物 diff 逐文件审阅、任务模板、首次引导。
- 总管展示「我参考了这些记忆」。

**交付物**：新项目不用重讲技术栈即可产出符合习惯的任务单；旧约束能被识别为不适用。

### P4：v2 多项目 + 远程 + 自动化（M4）

- 全局路由、多项目记忆、IM 入口（飞书/Telegram）、定时/触发任务。
- 云端执行体、团队共享记忆（可选）、插件/技能市场（可选）。

**交付物**：手机上发一句话，任务在本地/云端执行，待决策项推回 IM。

## 5. 关键机制落地方式

### 5.1 状态机

状态：`draft → planning → awaiting_approval → queued → running → awaiting_review → done`，旁路 `paused / blocked / failed / cancelled`。

- `awaiting_approval → queued` 只能由用户触发。
- 员工只上报事件，状态由调度器推进。
- `blocked` 必须带原因；`failed` 可重试回 `queued`。
- `done` 要求所有验收标准都有结论；`human` 类型由用户最终确认。
- 暂停保存前置状态，恢复时回到前置状态。

### 5.2 任务单

- 必填：`task_id / project_id / title / goal / deliverables / acceptance_criteria / budget`。
- 验收类型：`command / diff / rubric / human`；`command` 必须带 `check`。
- 缺字段或非法枚举直接拒绝进入执行。
- 完整契约持久化到 `tasks.contract_json`，避免只存摘要导致不可回放。

### 5.3 调度

- 依赖全部 `done` 才就绪。
- 全局并发默认 2，可配置；超限排队。
- 写域重叠的任务不并行；未声明写域视为与所有写任务冲突。
- 校验员只读，不参与写域互斥。
- 预算 70% 记警告事件，100% 硬停并转 `blocked`。

### 5.4 总管工具白名单

v0 只注册：`spawn_worker / assign_task / query_worker / collect_result / ask_human`。
`read_memory / write_memory` 随 P3 记忆层一起注册；v0 不保留空实现，避免假能力。

### 5.5 汇总

固定三块：`## 待你决策`、`## 未通过的检查`、`## 交付产物`。只回「完成了」视为不合格输出。

### 5.6 人审与预算

- 危险动作（删除、push、发布、付款、外发、安装系统级依赖）一律建 `approvals` 记录，阻塞等待。
- 单任务预算硬上限 + 项目日预算；成本按 `model_calls` 汇总。
- 事件 append-only；所有 API 变更写事件。

### 5.7 Worktree

- 路径：`%LOCALAPPDATA%\OpenCoxswain\worktrees\<project>\<task>`（可用 `OPENCOXSWAIN_HOME` 覆盖）。
- 分支：`opencoxswain/<task_id>`，基线为项目默认分支。
- Windows 文件锁：删除/清理重试 3 次，指数退避；失败转 `blocked` 并提示。

## 6. PRD 取舍与待确认项

| # | 问题 | 本次取舍 |
| --- | --- | --- |
| 1 | v0 摘要写 2–4 个子任务，功能表写 2–5 | 通用上限按 2–5；v0 剧本按 2–4 演示。 |
| 2 | PRD 指定 Node 22，本机 winget 仅提供 Node 24 | `engines >= 22`，只使用 Node 22 已有 API；不改变技术选型。 |
| 3 | v0 明确不做记忆，但总管白名单含记忆工具 | v0 只注册 5 个执行类工具；记忆工具随 P3 注册，不做空壳。 |
| 4 | OpenCode 首发，但本机未安装且无 Rust/MSVC | P0 用 Mock 适配器验证闭环与接口；v0.3.0 已用桌面版 CLI 完成 spike 与适配；Tauri 构建放到最后阶段。 |
| 5 | 总管需要 LLM，但无可用 Key | 无 Key 时 `planner.llm` 内部回退静态拆分；有 Key 时才发生费用。 |
| 6 | 许可证 PRD 标注「建议，待最终确认」 | 暂按 Apache-2.0 放置 LICENSE，保留最终确认项。 |
| 7 | 日预算、合并/冲突在 v0 清单中未逐条展开 | 日预算 P0 做最小实现；顺序合并与冲突转人审放 P2。 |
| 8 | `docs/adr/`、CONTRIBUTING 等开源文档 | 随 P1 发布流程补齐；P0 只保留 README，避免空文档。 |

## 7. 版本与分支

- SemVer；v1 前保持 `0.x`。新增功能升 minor，移除功能升 major，修复升 patch。
- 初始版本 `0.1.0`。
- 主分支 `main`；每个阶段完成后打 tag（`v0.1.0` P0、`v0.2.0` 插件化内核、`v0.3.0` OpenCode 运行时 + LLM Planner）。

## 8. 验证方式

- `pnpm typecheck`：全仓 TypeScript 严格检查。
- `pnpm test`：core 单元测试 + daemon 集成测试（临时 SQLite + 临时 git 仓库）。
- `pnpm e2e`：脚本走完 v0 剧本，断言状态、事件、汇总、预算。
- `pnpm e2e:opencode`：可选的真实链路验证（需要本机 OpenCode CLI）；临时仓库里让真实员工写文件并断言 diff，未安装时跳过。
- `pnpm dev`：Daemon + Vite 工作台；浏览器人工验证看板与暂停/审批。
- P1 起增加 Tauri 构建检查与 Windows 专项清单。
