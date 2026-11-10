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
| 桌面壳 | Tauri 2 | 已完成（v0.13.0）：Rust 侧启动 daemon 运行打包后的代码，WebView2 承载同一套 React 工作台；dev 与 NSIS 打包两条路径都已接通。v0.22.0 起安装包自带 Node.js 运行时，不再要求目标机器预装 Node。 |
| 验收 | 系统复核 + 人决策 | 已完成（v0.14.0）：子任务完成即可单独验收，根任务保留最终收口；四段决策说明与 p50/p95 反馈延迟用于呈现，不改变系统复核权威。交付侧（v0.15.0）复用同一说明，低风险才开放一键合并且需二次确认，失败自动回滚。 |
| UI | React 18 + TypeScript + Vite | 不引入组件库，工作台样式手写 CSS，避免额外依赖。 |
| 本地 Daemon | Node 22 + TypeScript | `engines >= 22`；当前验证环境为 Node 24 LTS，仅使用 Node 22 已支持的 API。 |
| 数据库 | SQLite + FTS5 | 使用 Node 内置 `node:sqlite`（Node 22.5+），零原生依赖；已实测 FTS5 可用。 |
| HTTP/事件 | `node:http` + SSE | PRD 允许 WebSocket/SSE；v0 用 SSE，单向事件流足够。 |
| 运行时 | OpenCode（首发） | v0.3.0 已接入桌面版 CLI（`runtime.opencode`，`run --standalone --format json`）；Mock 保留为测试替身。见 [spike-opencode.md](spike-opencode.md)。 |
| 包管理 | pnpm workspace | 与 PRD CI 一致；monorepo。 |
| 测试 | `node:test` | 不引入测试框架，降低依赖。 |
| 校验 | 手写契约校验器 | 按 PRD 附录字段逐项校验，不引入 JSON Schema 运行时依赖。 |
| 密钥 | Windows Credential Manager / DPAPI | v0.4.0 已接入 `secrets.dpapi` 插件：按当前用户 DPAPI 加密落盘，读取优先仓库、回退环境变量；`cmdkey` 无法读回密钥，故未采用 Credential Manager。 |
| 打包 | NSIS + Tauri Updater | NSIS 安装包已接入（v0.13.0，currentUser 安装）；MSI 与自动更新留待后续。 |

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
- 接入 LLM Planner（已完成，v0.3.0）：`planner.llm` 使用 OpenAI 兼容端点（默认 DeepSeek），BYO Key；无 Key、超时或解析失败自动回退静态拆分。v0.4.0 起 Key 优先从 DPAPI 仓库读取，环境变量仅作回退。
- 跑通真实仓库的「修夜间模式」剧本；危险动作人审（delete/push/publish/pay/external_send）已完成，见 v0.4.0。
- Windows 专项：中文/空格路径已完成（v0.23.1）：git 调用统一加 `-c core.quotepath=false`，worktree 创建 / 检视 / 合并 / 清理与 diff 产物、逐文件明细按原始文件名处理，回归测试覆盖中文加空格的仓库、worktree 根、产物目录与文件名。长路径已覆盖（v0.23.2）：实测 git 无法在超过 260 字符的工作目录里运行，且 Node 的 `spawn` 在这种目录下会抛出不可捕获的错误直接把 daemon 打挂；现在 `runGit` / adapters 工具层 / 验收侧 git 在 spawn 前就拦下并返回中文原因，`WorktreeManager.create` 在建目录前校验目标路径，`inspectRepo` 新增 `path_too_long`；同时打开 `core.longpaths`，仓库路径不长时超过 260 字符的深层文件可正常入库。进程清理已完成（v0.24.0）：验收命令与系统复核命令超时后按整棵进程树结束（Windows `taskkill /T /F`，POSIX 按进程组），不再残留孙进程占用 worktree；内核停止时 `OpenCodeRuntimeAdapter.disposeAll()` 收回活跃会话，未捕获异常与未处理拒绝同样触发卸载；桌面壳退出改为结束 daemon 进程树。强制结束 daemon 后遗留进程的启动时回收已完成（v0.25.0）：新增 `PidLedger`（`<home>/pids/<pid>.json`），OpenCode 进程启动即记账、退出即销账；daemon 启动时 `runtime.opencode` 调用 `reapOrphans()`，对仍存活且进程名匹配的记录按进程树强杀，PID 已被复用则只清记录。
- Tauri 2 桌面壳（已完成，v0.13.0）：桌面壳作为 daemon 的入口，启动时先拉起本地 daemon（`OPENCOXSWAIN_PORT` 固定端口），端口就绪后再创建窗口；退出时结束 daemon 进程树（v0.24.0 起）。安装包由 `scripts/package-daemon.mjs` 把 daemon 与工作区包摊平进 `src-tauri/staging`；v0.22.0 起同时带上 Node.js 运行时，安装后不再要求系统预装 Node（开发与构建仍需 Node >= 22）。

**交付物**：插件化 Daemon 与工作台；真实 OpenCode 员工；真实 diff 与测试报告；预算硬停；Tauri 安装包（v0.13.0 已产出 NSIS）。

### P2：v0 收口与内测（M1 后半 + M2）

- 安全护栏（已完成，v0.4.0）：运行时成本实时累计，任务/项目日预算超限立即取消会话、冻结任务并产出「待你决策」；delete / push / publish / pay / external_send 建审批记录并冻结会话，批准后继续或重新排队；`secrets.dpapi` 托管 LLM Key。
- DAG 2–5 子任务、写域冲突、顺序合并、冲突转人审（已完成，v0.5.0）：多依赖任务在新 worktree 内按依赖顺序合并，冲突即中止、清理并建 `merge_conflict` 审批，任务转 `blocked` 等待人工处理。
- 暂停/终止/接管（已完成，P1）；失败重试矩阵（v0.5.0 完成「原员工自动重试 1 次 → 问人」；换强模型、拆任务留待 v1）。
- 日预算（已完成，v0.4.0）、成本报表与回放导出（已完成，v0.5.0）、崩溃恢复（基础版已完成：重启后运行中任务转 `blocked` 并提示）。
- 自用内测，记录「拆错/跑偏/验收失败」案例，反推 v1 记忆优先级。
- 验收自证与逐条验收（已完成，v0.7.0）：`finish()` 不再采信员工自报，command 由系统在 worktree 内重跑、diff 用 git 复算，rubric/human 一律交人；`POST /api/tasks/:id/acceptance` 要求逐条给出结论与理由，验收单包含交付物、证据摘要、验收标准、验收人与结论并落库；删除 `/accept` 批量盖章；`GET /api/tasks?stage=` 与工作台「在等谁」标签落地阶段视图。
- 运行中输入与规则监察（已完成，v0.8.0）：`POST /api/tasks/:id/inputs` 在运行时支持时立即送达，否则诚实排队并在下次派发注入，人的消息不受并发上限约束；`supervisor.rules` 插件按规则检查越权、空转、心跳、重复、停滞、预算与长尾，动作落 `supervision_actions` 并可回放，重复触发升级暂停，空转完成直接判失败。
- 授权与副作用（已完成，v0.10.0）：任务授权从「写路径枚举」升级为能力化 `TaskMandate`（能力集合 + 根目录 + 可执行角色），员工包声明 `capabilities`，项目创建只问工作目录 / 能否联网 / 能否外发，安装前可查能力差异；`fs.write` / `fs.delete` / `proc.exec` / `net.send` 先记账后执行并落 `side_effects` 台账，幂等键去重，外发一律审批且不可逆；回滚能力明确为可追溯 / 可补偿 / 仅 git 内可回滚。
- 委派与恢复（已完成，v0.11.0）：`DelegationMode` v1 只接受 `fixed`；`failed` / `blocked` 子任务可重派，跨编制自动重签 `TaskMandate` 并落 `task.reassigned`；重启恢复时清理 `done` / `cancelled` 的孤儿 worktree，失败/阻塞保留现场；工作台新增任务树 DAG 分层视图与待决策收件箱。

**交付物**：满足 PRD v0 五条验收剧本；可回放覆盖率 100%。

### P3：v1 记忆 + 完整工作台（M3）

- 员工插件包（已完成，v0.6.0）：`employees` 服务 + `employee:use` / `employee:provide` 权限；四个内置员工（调研员/实施员/校验员/撰写员）由独立 Manifest 注册角色、技能、工具白名单、权限与默认验收标准；调度器删除硬编码 `ROLE_TEMPLATES`，Planner 只读判定与验收默认值均取自员工包；`GET /api/employees` 与工作台展示五件套。
- `packages/memory`（已完成，v0.12.0）：SQLite（FTS5）为唯一事实来源，Markdown 快照导出 `user_profile.md` / `project_memory.md` / `decisions.md` / `lessons.md`；中文二元组索引 + 关键词覆盖率与时间衰减混合排序。
- 写入门槛（已完成，v0.12.0）：来源必需、拒绝临时指令/疑似密钥/过短内容；同键新结论取代旧记忆，重复内容去重；冲突与取代过程可审计。
- 记忆检查器（已完成，v0.12.0）：`GET /api/memory/check` 报告重复、无来源、疑似密钥、同键冲突与陈旧条目。
- 总管展示「我参考了这些记忆」（已完成，v0.12.0）：任务单消息固定段落 + `memory.used` 事件；LLM Planner 提示词注入命中记忆；创建项目时识别技术栈。
- 验收体验（已完成，v0.14.0）：任意 `awaiting_review` 任务可单独验收，子任务先完成先汇报，根任务仍由人最终收口；验收单展示四段决策说明（改了什么 / 为什么 / 验过什么 / 还有什么风险），证据默认折叠，冲突给出判定理由；说明由系统按契约与复核结果生成，不采信员工自述。收件箱展示子任务待验收、根任务「汇总中 N/M」与每条已等待时长。
- 反馈延迟可观测（已完成，v0.14.0）：tasks 表记录 `finished_at` / `first_viewed_at` / `decided_at`，`GET /api/review-latency` 与快照 `review` 输出完成→查看、完成→决定 p50/p95 及当前等待数。
- 交付说明与一键合并（已完成，v0.15.0）：`GET /api/tasks/:id/delivery` 复用四段决策说明，补目标分支、待合并分支、改动规模、回退命令、风险与阻塞原因，风险由系统按交付物类型 / 删除行数 / 副作用计算；`POST /api/tasks/:id/merge` 仅在低风险交付开放，要求 `confirm: true` 与 `planHash` 一致，失败自动 `git merge --abort` + `git reset --hard` 回滚；高风险只给分支与手动指引。
- 租约现场标记（已完成，v0.15.0）：重启时租约未过期的 run 保留 `running` 并落 `recovered_unknown`（tasks 表迁移到 user_version=7），由 supervisor 继续观察；过期才判孤儿并重排。
- 逐文件审阅与任务树审计（已完成，v0.16.0）：`GET /api/tasks/:id/diff-review` 把整块 patch 拆成按文件明细（新增 / 删除 / 重命名、增删行数，二进制与大文件显式提示，不静默截断），根任务汇总子任务并去重；验收单、交付说明与产物面板共用同一明细，挂在四段说明的「改了什么」下，不另起叙述。任务树节点可展开查看负责人、分支、当前阶段、逐条验收结论与最近关键事件，失败 / 阻塞 / 被打回直接标出卡点；DAG 仅保留依赖关系。
- 首次引导与多项目（已完成，v0.17.0）：首次启动直接进入接入表单，左栏三步清单（接入仓库 → 生成任务单 → 确认开工）完成后自动隐藏；`inspectRepo` 区分路径不存在、不是文件夹、没有权限、不是 git 仓库、git 不可用与空仓库，`POST /api/projects` 以 400 返回可直接展示的中文原因。左栏「项目」面板与顶栏下拉支持多仓库切换与接入新项目，任务、事件、消息、产物、审批、验收与记忆统计均按 `project_id` 隔离，项目级预算与并发上限各自独立，最近项目记在本地并在下次启动恢复。
- 任务模板（已完成，v0.18.0）：内置「修缺陷 / 小功能 / 写文档 / 重构 / 调研」五类，由 `template.registry` 插件提供，`GET /api/templates` 与工作台快照可读。模板声明目标描述、默认交付物、验收方式、默认写入范围、是否允许一键合并；`POST /api/projects/:id/plan` 接受 `templateId`，自动落成主执行 + 校验两个子任务并写入 `template_id` / `allow_auto_merge`，但状态仍是 `awaiting_approval`，`acceptancePolicy` 固定 `unverified_only`。交付阶段模板不允许时直接阻止一键合并；前端在输入框上方预览全部默认授权，模板来源插件 id 一并展示。

已提前完成（v0.11.0）：待决策收件箱、任务树 DAG 可视化、任务重派入口。

**交付物**：新项目不用重讲技术栈即可产出符合习惯的任务单；旧约束能被识别为不适用。

### P4：v2 多项目 + 远程 + 自动化（M4）

- 定时任务（已完成，v0.19.0）：`schedules` 服务由 `trigger.schedule` 插件提供，任务按项目持久化（标题、目标、可选模板、间隔），到点只调用 `steward.createPlan` 生成一张待审批任务单，不自动开工、不降低验收强度；项目已有未完成任务时整次跳过，错过时段不补跑，下一次按间隔重算。`GET/POST /api/schedules`、`POST /api/schedules/:id/enabled`、`POST /api/schedules/:id/run`、`DELETE /api/schedules/:id`；工作台底部「定时」标签可新建、启停、立即生成与删除。
- 全局路由（已完成，v0.20.0）：`router` 服务由 `router.global` 插件提供，`POST /api/route` 用本地规则把一句话目标映射到已有项目，按项目名/路径命中 ×3、项目记忆命中 ×2、最近任务命中 ×1 打分，最多返回 3 个候选与 3 条理由；只给建议，不建单、不改项目状态。
- 跨项目记忆检索（已完成，v0.20.0）：`GET /api/memory?scope=all&q=` 覆盖所有项目与全局记忆，结果自带 `projectId`；检索只读，不改写 `useCount` / `lastUsedAt`，不影响时间衰减排序；不带 `scope` 时仍只查全局记忆。
- 门禁质量（已完成，v0.23.0）：`GET /api/gate-quality?projectId=` 只读聚合验收事件，按「任务 + 验收项取最后一次判定」分别给出系统自动判定、系统通过 / 拦下、待人工与人工收口数量及通过率；无样本返回 `null`，不改验收记录，也不编造事件里无法证实的误报率。
- IM 入口（已完成飞书部分，v0.26.0）：`channels` 服务负责配置落盘（`<home>/channels.json`）、事件路由与静默窗口去重，`channel.feishu` 插件负责出站签名（`timestamp + sign`）与入站回调（`X-Lark-Signature` 校验、`encrypt` 解密、challenge 应答）；设置页可配 Webhook、签名密钥、通知类别与启停，凭据不回显；群内支持「待办 / 状态 / 批准 / 退回」只读与拍板指令，退回必须带理由，不开放建单。Telegram 通道留待后续。
- 自动更新（已完成，v0.27.0）：桌面壳接入 Tauri Updater，新增 `app_version` / `update_check` / `update_install` 三个命令与设置页「版本与更新」区块，可显示当前版本、检查新版本、查看发布说明并一键安装后重启；更新源地址与公钥放本机 `updater.json`（也可用 `OPENCOXSWAIN_UPDATER_ENDPOINT` / `OPENCOXSWAIN_UPDATER_PUBKEY` 覆盖），未配置时不发网络请求。`pnpm desktop:release` 通过 `tauri.release.json` 打开 `createUpdaterArtifacts`，为安装包产出 `.sig` 签名，普通 `desktop:build` 不受影响。
- 云端执行体、团队共享记忆（可选）、远程插件市场（条件触发：问卷 H14「装现成」≥40% 且 capability diff 通过评审）。

**交付物**：手机上发一句话，任务在本地/云端执行，待决策项推回 IM。

## 5. 关键机制落地方式

### 5.1 状态机

状态：`draft → planning → awaiting_approval → queued → running → awaiting_review → done`，旁路 `paused / blocked / failed / cancelled`。

- `awaiting_approval → queued` 只能由用户触发。
- 员工只上报事件，状态由调度器推进。
- `blocked` 必须带原因；`failed` 可重试回 `queued`。
- `done` 要求所有验收标准都有结论；`human` 类型仍由用户确认，是否产生人工待办由 `AcceptancePolicy` 决定。
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
- 预算 70% 记警告事件，100% 硬停：v0.4.0 起在运行中按 `cost` 事件实时累计，超限立即取消会话、转 `blocked` 并产出待决策消息；项目日预算同样在 tick 中实时核对并中止活跃会话。
- 失败重试：v0.5.0 起运行时返回 `retryable` 错误时在同一任务内自动重试（最多 2 次尝试），耗尽后升级「待你决策」；用户可通过 `POST /api/tasks/:id/retry` 重新排队。

### 5.4 总管工具白名单

v0 只注册：`spawn_worker / assign_task / query_worker / collect_result / ask_human`。
`read_memory / write_memory` 随 P3 记忆层一起注册；v0 不保留空实现，避免假能力。

### 5.5 汇总

固定三块：`## 待你决策`、`## 未通过的检查`、`## 交付产物`。只回「完成了」视为不合格输出。

### 5.6 人审与预算

- 危险动作（删除、push、发布、付款、外发、安装系统级依赖）一律建 `approvals` 记录，阻塞等待；`net.send` 无论是否已获项目外发授权，都必须逐次审批且标记为不可逆。
  - 能在执行前挂起的运行时（Mock）通过 `ApprovalGate` 在动作前冻结，批准后原会话继续、拒绝则终止。
  - 外部进程运行时（OpenCode）无法在执行前阻断：调度器在 `tool_call` 事件边界识别后立即取消会话、冻结任务；批准后任务重新排队，已批准的同名动作自动放行。
  - 所有副作用在 `tool_call` 边界先落 `side_effects` 为 `pending`，收到结果后结算；审批拒绝记 `rejected`，中断则保留 `pending` 供重启排查。
- 单任务预算硬上限 + 项目日预算；成本按 `model_calls` 汇总，运行中按运行时 `cost` 事件实时累计；硬停时先落账已发生成本再中止。
- 事件 append-only；所有 API 变更写事件。审批通过 `GET /api/bootstrap` 暴露，决策走 `POST /api/approvals/:id/decide`。
- 密钥：`secrets` 服务优先读 DPAPI 仓库（`<home>/secrets/*.bin`，当前用户加密），未命中回退 `OPENCOXSWAIN_LLM_API_KEY` / `DEEPSEEK_API_KEY`；HTTP 只暴露来源，不返回密钥。
- 成本与回放：`GET /api/projects/:id/costs` 输出总量与按模型/任务/日分组；`GET /api/tasks/:id/replay?format=markdown` 导出完整回放（子任务、员工、审批、产物、事件、汇总）。

### 5.7 Worktree

- 路径：`%LOCALAPPDATA%\OpenCoxswain\worktrees\<project>\<task>`（可用 `OPENCOXSWAIN_HOME` 覆盖）。
- 分支：`opencoxswain/<task_id>`，基线为项目默认分支；多依赖时以首个依赖分支建 worktree，再按顺序 `git merge --no-ff` 其余依赖分支。
- 合并冲突：中止合并、清理该 worktree、建 `merge_conflict` 审批并转 `blocked`；不修改用户主分支，由用户手动解决后批准重试。
- Windows 文件锁：删除/清理重试 3 次，指数退避；失败转 `blocked` 并提示。

## 6. PRD 取舍与待确认项

| # | 问题 | 本次取舍 |
| --- | --- | --- |
| 1 | v0 摘要写 2–4 个子任务，功能表写 2–5 | 通用上限按 2–5；v0 剧本按 2–4 演示。 |
| 2 | PRD 指定 Node 22，本机 winget 仅提供 Node 24 | `engines >= 22`，只使用 Node 22 已有 API；不改变技术选型。 |
| 3 | v0 明确不做记忆，但总管白名单含记忆工具 | v0 只注册 5 个执行类工具；记忆工具随 P3 注册，不做空壳。 |
| 4 | OpenCode 首发，但本机未安装且无 Rust/MSVC | P0 用 Mock 适配器验证闭环与接口；v0.3.0 已用桌面版 CLI 完成 spike 与适配；Tauri 构建在 v0.13.0 完成。 |
| 5 | 总管需要 LLM，但无可用 Key | 无 Key 时 `planner.llm` 内部回退静态拆分；有 Key 时才发生费用。 |
| 6 | 许可证 PRD 标注「建议，待最终确认」 | 暂按 Apache-2.0 放置 LICENSE，保留最终确认项。 |
| 7 | 日预算、合并/冲突在 v0 清单中未逐条展开 | 日预算 P0 做最小实现；顺序合并与冲突转人审放 P2。 |
| 8 | `docs/adr/`、CONTRIBUTING 等开源文档 | 随 P1 发布流程补齐；P0 只保留 README，避免空文档。 |

### 6.1 竞品调研结论（后续设计约束）

以下方向与 PRD 不冲突，作为 P3/P4 的硬约束，从 v0.5.0 起在契约与架构上按此演进：

1. **验收是一等公民**：验收单是显式对象（交付物、证据、验收标准、验收人、结论），可追溯、可回放；不以 diff 视图代替。
2. **员工是可安装插件包**：角色 + 技能 + 工具 + 权限 + 验收标准五件套，沿用现有插件契约，不做成提示词预设。（v0.6.0 已落地）
3. **任务树是审计对象**：可展开、可追溯、可重派；回滚能力分级：可追溯（全量）/ 可补偿（文件与进程）/ 仅 git 内可回滚。
4. **调度与分工固化在系统结构中**：委派必须结构化，理由是可审计、成本可归因、模型输出不稳定（0/5 实验仅作支持性证据，样本为合成负载）。
5. **差异化**：Windows 本地优先 + 本地可安装员工包；避免退化为无壁垒的「并行会话管理器」。

## 7. 版本与分支

- SemVer；v1 前保持 `0.x`。新增功能升 minor，移除功能升 major，修复升 patch。
- 初始版本 `0.1.0`。
- 主分支 `main`；每个阶段完成后打 tag（`v0.1.0` P0、`v0.2.0` 插件化内核、`v0.3.0` OpenCode 运行时 + LLM Planner、`v0.4.0` 预算硬停 + 危险动作人审 + DPAPI 密钥托管、`v0.5.0` 失败重试 + 冲突转人审 + 成本报表 + 回放导出、`v0.6.0` 员工插件包）。

## 8. 验证方式

- `pnpm typecheck`：全仓 TypeScript 严格检查。
- `pnpm test`：core 单元测试 + daemon 集成测试（临时 SQLite + 临时 git 仓库）。
- `pnpm e2e`：脚本走完 v0 剧本，断言状态、事件、汇总、预算。
- `pnpm e2e:opencode`：可选的真实链路验证（需要本机 OpenCode CLI）；临时仓库里让真实员工写文件并断言 diff，未安装时跳过。
- 安全护栏测试：`budget.test.ts` 断言运行中超限即停并产出待决策；`approval.test.ts` 断言批准后继续、拒绝后终止；`secrets.test.ts` 断言 DPAPI 密文落盘与环境变量回退。
- `pnpm dev`：Daemon + Vite 工作台；浏览器人工验证看板与暂停/审批。
- `pnpm desktop` / `pnpm desktop:build`（v0.13.0）：Tauri dev 与 NSIS 打包检查，Windows 专项清单随桌面壳一起验证。
