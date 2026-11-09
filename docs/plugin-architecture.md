# OpenCoxswain 插件架构（P1）

## 1. 目标

把 OpenCoxswain 从「内建模块直接互相 import」改造成与 DeepSeek Harness 同构的「一切皆插件」架构：

- 内核只保留四件事：**插件生命周期、事件总线、权限闸门、任务状态机**。
- 运行时适配器、Planner/总管、调度器、worktree、存储、HTTP API、SSE、界面面板、检查器全部通过统一插件契约注册与加载。
- 内置插件与外部插件走同一条路径，不存在「只有内置模块能调用」的后门。
- P0 的 Mock 运行时、静态 Planner、三栏面板、底部检查器改为插件后，现有 e2e 全流程必须继续通过。

非目标（P2+）：

- 进程级/OS 级沙箱隔离；P1 的隔离边界是**进程内服务可见性 + 权限清单**，不是安全沙箱。
- 插件热重载、远程插件市场、插件签名。v1 的插件能力是本地目录安装，不承诺远程市场。
- Tauri 桌面壳；P1 仍以浏览器 + 本地 Daemon 形式运行。

## 2. 对齐依据

DeepSeek Harness（DSH）基于 Cordis 构建，公开资料中的关键特征：

- 没有特权内核；模型、工具、技能、会话、沙箱、存储、Agent 循环、调度、UI 都是 Cordis 插件，注册在同一个 context 上。[DSH 介绍](https://www.deepseek.com/harness/en/)
- 上下文是服务容器，服务占据稳定的 `ctx.<key>`；插件通过 `inject` 声明依赖，加载顺序由服务依赖推导，而不是手写启动顺序。[Cordis 入门](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)
- 类型化事件用于通信，分发模式固定为 `emit` / `waterfall` / `parallel` / `serial` / `bail`。
- 注册是可逆副作用：通过 `ctx.effect()` / `ctx.on()` 安装，卸载时可清理。
- 能力通过配置选择、替换、扩展，不改 harness 源码。

OpenCoxswain 不直接依赖 Cordis：PRD 未要求该依赖，且引入整套框架会超出当前范围。我们实现一个**最小同构内核**，保留上述五个语义，并用 `@opencoxswain/plugin-api` 固定契约。

## 3. 内核边界

`packages/plugin-api` 定义契约，`apps/daemon/src/kernel` 实现内核。

内核只提供：

| 能力 | 说明 |
| --- | --- |
| 生命周期 | 校验清单、拓扑排序、动态 import、`apply`、逆序卸载、失败回滚 |
| 事件总线 | 服务事件 `on/emit/parallel`；领域事件 `publish/subscribe` |
| 权限闸门 | 服务提供与服务消费两侧的权限校验 |
| 状态机 | 任务状态迁移表与 `assertTransition`，来自 `@opencoxswain/core` |

内核**不**知道 Store、Scheduler、Steward、Mock、HTTP 路由、SSE、React 面板的存在。

## 4. 插件契约

### 4.1 清单（Manifest）

```ts
interface PluginManifest {
  apiVersion: 1;
  id: string;                 // 例：runtime.mock
  name: string;
  version: string;            // semver
  kind: PluginKind;           // runtime | planner | scheduler | steward | storage |
                              // transport | api | ui | worktree | other
  entry: string;              // file:// 或绝对路径，指向 ESM 模块
  provides: ServiceKey[];     // 本插件注册的服务
  inject: ServiceKey[];       // 本插件消费的服务
  permissions: Permission[];  // 提供/消费服务所需权限
  enabled?: boolean;
  config?: unknown;           // 插件私有配置，由插件自行校验
}
```

### 4.2 模块

```ts
interface PluginModule {
  apply(ctx: PluginContext, config: unknown): void | Promise<void> | PluginDisposer;
}
```

`apply` 必须同步完成服务注册，或在返回前完成；异步初始化通过 `await`。返回的 disposer 与 `ctx.effect()` 注册的清理函数一起，在卸载时逆序执行。

### 4.3 上下文

```ts
interface PluginContext {
  readonly id: string;
  readonly config: Readonly<OpenCoxswainConfig>;
  service<K extends ServiceKey>(key: K): ServiceMap[K];
  provide<K extends ServiceKey>(key: K, value: ServiceMap[K]): void;
  effect(dispose: PluginDisposer): void;
  on(event: string, listener: (payload: unknown) => void | Promise<void>): PluginDisposer;
  emit(event: string, payload: unknown): void;
  requirePermission(permission: string): void;
  log(message: string): void;
}
```

约束：

- `service()` 只允许访问清单 `inject` 中声明的服务；访问未声明服务直接抛错。
- `provide()` 只允许注册清单 `provides` 中声明的服务；重复注册抛错。
- `provide()` 时内核把该服务的 `requiredPermissions` 与消费方清单比对，缺权限即拒绝。
- 没有 `ctx.kernel`、没有全局单例、没有 `import` 具体实现后再调用其方法的特权通道。

### 4.4 服务表

| key | 契约 | 提供方 | 消费方需要权限 |
| --- | --- | --- | --- |
| `config` | 只读运行配置 | 内核 | — |
| `events` | 领域事件发布/订阅 + 生命周期事件 | 内核 | `events:publish` / `events:read` |
| `storage` | SQLite 持久化 | `storage.sqlite` | `storage:read`、`storage:write` |
| `worktrees` | 创建/删除任务 worktree | `worktree.git` | `fs:worktree`、`process:spawn` |
| `runtimes` | 运行时注册表与健康检查 | `runtime.registry` | `runtime:use` |
| `planner` | 目标 → 任务契约 | `planner.llm`（无 Key 时回退静态引擎） | `planner:use` |
| `scheduler` | 派发、暂停、恢复、终止 | `scheduler` | `scheduler:control` |
| `steward` | 总管编排与快照 | `steward` | `steward:call` |
| `secrets` | 密钥读写与来源查询（DPAPI 优先，环境变量回退） | `secrets.dpapi` | `secrets:read` |
| `http` | 路由注册、监听、关闭 | `transport.http` | `http:route` |

## 5. 发现与加载

### 5.1 清单来源

1. **内置清单**：`apps/daemon/src/plugins/manifests.ts` 只包含数据（id/entry/provides/inject/permissions/config），不 import 任何实现。
2. **外部清单**：`<home>/plugins/<name>/plugin.json`。`entry` 相对清单目录解析；`apiVersion` 必须为 `1`。
3. 合并规则：同 `id` 外部清单覆盖内置清单；`enabled: false` 表示禁用。外部插件可以替换 Mock、Planner、存储、HTTP，甚至禁用内置面板。

### 5.2 加载顺序

- 校验清单：`apiVersion`、重复 id、`entry` 存在、`provides` 不重复。
- 按 `inject`/`provides` 拓扑排序；内核在加载前已提供 `config`、`events`。
- 逐个动态 `import(entry)`，读取 `apply`，创建受限上下文，调用 `apply`。
- 任一插件失败：按已加载顺序逆序卸载，清空服务，启动失败。
- 加载完成后 `kernel.start()` 并行触发 `kernel.ready`；HTTP 开始监听、调度器开始 tick 都通过该事件启动，避免「谁先启动」的隐式约定。
- 关闭时 `kernel.stop()` 逆序卸载；调度器、HTTP、Store 由各自插件通过 disposer 收尾。

### 5.3 禁止后门

- `app.ts` 只做三件事：读配置、创建内核、加载清单并启动。它不 import 任何插件实现，不 new Store/Scheduler/Steward。
- 测试与脚本只通过 HTTP 与 `startDaemon()` 返回的 `port/close` 交互；不直接拿 Store/Bus/Scheduler。
- 新增能力必须新增清单 + 模块；不允许在 `app.ts` 或内核里直接 `new`。

## 6. 权限与隔离

### 6.1 权限清单

| 权限 | 用途 |
| --- | --- |
| `events:publish` | 发布生命周期事件 |
| `events:read` | 订阅领域事件（SSE、审计） |
| `storage:read` / `storage:write` | 读写 SQLite |
| `storage:provide` | 提供存储服务 |
| `fs:data` | 访问应用数据目录 |
| `fs:worktree` | 读写任务 worktree |
| `process:spawn` | 启动 git / 运行时进程 |
| `runtime:use` | 调度器取用运行时 |
| `runtime:provide` | 注册运行时适配器 |
| `planner:use` | 调用 Planner |
| `scheduler:control` | 暂停/恢复/终止任务 |
| `steward:call` | 调用总管服务 |
| `secrets:read` / `secrets:write` | 读取/写入托管密钥 |
| `secrets:provide` | 提供密钥托管服务 |
| `http:route` | 注册 HTTP/SSE 路由 |
| `net:listen` | 监听本地端口 |
| `ui:panel` | 注册界面面板/检查器 |

### 6.2 执行点

- **服务提供**：插件只能 `provide()` 自己 `provides` 中的 key，且必须具备该服务声明的 `providerPermissions`。
- **服务消费**：`service()` 校验消费清单是否包含该服务的 `requiredPermissions`。
- **敏感操作**：运行时插件与 worktree 插件在清单中声明 `process:spawn`/`fs:worktree`；存储插件声明 `fs:data`；HTTP 插件声明 `net:listen`。
- **领域事件**：通过 `events.publish` 发布需要持久化的记录；生命周期事件仅进程内。

### 6.3 隔离边界（诚实说明）

P1 插件与内核同进程运行，Node 原生模块无法被语言层真正拦截。权限闸门保证的是：

- 插件不能通过内核上下文访问未声明的服务；
- 插件不能注册未声明的服务；
- 插件不能绕过权限清单使用受控服务。

真正的恶意代码隔离（独立进程/Worker + IPC 白名单 + 资源配额）放在 P2，与 Tauri sidecar 一起做。P1 的外部插件应视为受信任插件。

## 7. P0 → 插件映射

| P0 模块 | 新插件 id | provides | inject | 权限 |
| --- | --- | --- | --- | --- |
| `store.ts` | `storage.sqlite` | `storage` | `config` | `fs:data`、`storage:provide` |
| `worktree.ts` + `git.ts` | `worktree.git` | `worktrees` | `config` | `fs:worktree`、`process:spawn` |
| 新 | `runtime.registry` | `runtimes` | — | `runtime:provide` |
| `MockRuntimeAdapter` | `runtime.mock` | — | `runtimes` | `runtime:use`、`runtime:provide`、`fs:worktree`、`process:spawn` |
| `OpenCodeRuntimeAdapter` | `runtime.opencode` | — | `runtimes` | `runtime:use`、`runtime:provide`、`fs:worktree`、`process:spawn` |
| 新 | `secrets.dpapi` | `secrets` | `config` | `secrets:provide`、`secrets:read`、`secrets:write`、`fs:data` |
| `planner.ts` 静态引擎 | `planner.llm`（有 Key 调 LLM，否则用同一引擎静态拆分） | `planner` | `config`、`events`、`secrets` | `planner:use`、`events:publish`、`secrets:read` |
| `scheduler.ts` | `scheduler` | `scheduler` | `storage`、`events`、`config`、`runtimes`、`worktrees` | `scheduler:control`、`storage:read/write`、`events:publish`、`runtime:use`、`fs:worktree`、`process:spawn` |
| `steward.ts` | `steward` | `steward` | `storage`、`events`、`planner`、`scheduler`、`runtimes` | `steward:call`、`storage:read/write`、`events:publish`、`planner:use`、`scheduler:control`、`runtime:use` |
| `server.ts` 的 HTTP 壳 | `transport.http` | `http` | `config`、`events` | `net:listen`、`http:route` |
| `server.ts` 的 REST 路由 | `api.rest` | — | `config`、`http`、`storage`、`steward`、`runtimes`、`secrets` | `http:route`、`storage:read`、`steward:call`、`runtime:use`、`secrets:read`、`secrets:write`、`fs:data` |
| `server.ts` 的 `/api/events` | `transport.sse` | — | `http`、`storage`、`events` | `http:route`、`storage:read`、`events:read` |
| `apps/desktop` 三栏 + 检查器 | 八个 UI 插件（3 个面板 + 5 个检查器标签） | — | UI Registry | `ui:panel` |

> 服务级权限是粗粒度的：消费 `storage` / `events` 时内核要求同时具备读写权限，因此事件消费者在清单里会显式声明 `storage:read/write` 与 `events:read/publish`。真正的按方法鉴权留到 P2 的进程隔离阶段。

删除项：

- `app.ts` 中所有 `new Store/EventBus/Scheduler/Steward/Mock/WorktreeManager` 与手工 hook 装配。
- `Scheduler.setHooks` 与 `Steward.setControl` 的直接互相引用；改为 `root.settled` 事件 + 服务调用。
- `server.ts` 单体服务器；拆成 `transport.http` + `api.rest` + `transport.sse`。
- 桌面端 `App.tsx` 对三栏组件和 Inspector 的硬编码 import。

## 8. 界面插件契约

```ts
interface UiPlugin {
  id: string;
  title: string;
  slot: 'left' | 'center' | 'right' | 'bottom';
  order: number;
  render: React.ComponentType;
}
```

- `UiRegistry` 提供 `register/unregister/list(slot)`；内置面板与外部面板走同一个 `register`。
- `App.tsx` 只渲染布局槽位，按 `order` 渲染注册表中的组件。
- 底部检查器由多个 `slot: 'bottom'` 的标签页插件组成；`Inspector` 退化为「标签容器 + 注册表」，不再认识时间线/产物/汇总/花费/设置。
- 面板通过 `WorkbenchProvider` 获取快照、派生任务树、动作与错误提示，不直接 import 其他面板。

P1 只加载内置 UI 插件；P2 在 Tauri 中增加从插件目录加载前端 bundle 的能力。加载路径与权限语义已固定，后续不需要改契约。

## 9. 启动与关闭时序

启动：

1. `loadConfig()`。
2. 创建内核，注册 `config`、`events`。
3. 读取内置清单 + 外部 `plugin.json`，合并、校验、拓扑排序。
4. 依次加载：`storage.sqlite` → `worktree.git` → `runtime.registry` → `runtime.mock` → `runtime.opencode` → `secrets.dpapi` → `planner.llm` → `scheduler` → `steward` → `transport.http` → `api.rest` → `transport.sse`。
5. `kernel.start()`：并行触发 `kernel.ready`；调度器启动、HTTP 监听。
6. `startDaemon()` 返回 `{ config, port, close }`。

关闭：

1. `kernel.stop()` 逆序执行 disposer。
2. 停止调度器并取消活跃会话。
3. 关闭 HTTP。
4. 关闭 SQLite。

## 10. 验证

- `pnpm typecheck`：插件 API 与服务契约类型检查。
- `pnpm test`：core 单测 + daemon e2e。
- `pnpm e2e`：外部 HTTP 视角跑通「接入 → 计划 → 审批 → 实施/校验 → 汇总 → 验收 → 回放」。
- 新增内核单测：拓扑排序、缺失依赖、权限拒绝、回滚卸载、重复服务。
- 新增插件清单测试：内置清单的 `provides` 覆盖所有 `inject`。

## 11. 取舍

1. **不引入 Cordis**：保持零额外依赖，用 `@opencoxswain/plugin-api` 固化同构语义；未来若引入 Cordis，可把该包作为适配层。
2. **UI 插件先内置**：浏览器环境无法安全地从任意路径加载 React bundle；P1 先统一契约与注册表，P2 在 Tauri 里补外部加载。
3. **权限是架构闸门而非安全沙箱**：进程内插件共享 Node 权限，P2 再用独立进程解决。
4. **运行时注册表仍用 Map**：P1 不做热插拔；插件加载完成后注册表固定，调度器直接读取。

## 12. 实施状态与下一步

已完成（v0.2.0）：

1. 内核、`@opencoxswain/plugin-api`、内置清单与全部 daemon 插件落地；`app.ts` 只读配置、建内核、加载清单并启动。
2. 内核单测覆盖拓扑排序、缺失依赖、权限拒绝、回滚卸载、重复服务与清单覆盖；`pnpm test`、`pnpm e2e` 通过。
3. 桌面端 `UiRegistry` + `WorkbenchProvider` 落地，三栏与五个检查器标签均通过同一个 `register` 加载。

已完成（v0.3.0）：

1. OpenCode Windows spike 完结，结论与替代路线见 [spike-opencode.md](spike-opencode.md)。
2. `runtime.opencode` 插件接入桌面版 CLI；与 `runtime.mock` 走同一个注册契约，无内建分支。
3. `planner.llm` 替换 `planner.static`：有 Key 走 OpenAI 兼容端点，无 Key / 超时 / 解析失败回退同一静态引擎；`PlannerService.plan` 允许异步。
4. 新增配置项 `defaultRuntime`、`defaultModel`、`opencodeBin`；`pnpm test`、`pnpm e2e`、`pnpm e2e:opencode` 均通过。

已完成（v0.4.0）：

1. 运行时 `cost` 事件接入调度器：任务/项目日预算运行中实时核对，超限取消会话、冻结任务并产出待决策消息；硬停前先落账已发生成本。
2. `ApprovalGate` 危险动作闸门：Mock 在执行前冻结，OpenCode 在 `tool_call` 边界冻结；五类动作建 `approvals`，批准后继续或重新排队。
3. `secrets.dpapi` 插件提供 `secrets` 服务，LLM Key 按当前 Windows 用户加密落盘；`GET/PUT/DELETE /api/secrets/llm` 只暴露来源不返回密钥。
4. `pnpm test`、`pnpm e2e`、`pnpm e2e:opencode` 均通过。

已完成（v0.5.0）：

1. 失败重试：运行时返回 `retryable` 错误时同一任务内自动重试（最多 2 次尝试），耗尽后升级「待你决策」；`POST /api/tasks/:id/retry` 支持用户手动重排队。
2. 顺序合并与冲突转人审：`WorktreeService.create` 接收依赖分支列表，逐个 `git merge --no-ff`；冲突抛 `MergeConflictError`，调度器建 `merge_conflict` 审批并将任务转 `blocked`。
3. 成本报表：`GET /api/projects/:id/costs` 输出总量与按模型/任务/日分组。
4. 回放导出：`GET /api/tasks/:id/replay?format=markdown` 输出完整回放。
5. `pnpm test`、`pnpm e2e` 均通过。

已完成（v0.6.0）：

1. 员工插件包：新增 `employees` 服务与 `employee:use` / `employee:provide` 权限；每个员工由独立 Manifest 注册角色、技能、工具白名单、权限声明与默认验收标准，调度器与 Planner 只从注册表取值。
2. 删除调度器内硬编码的 `ROLE_TEMPLATES`；只读判定、默认验收标准、`worker.spawned` 事件中的员工来源全部来自员工包。
3. 内置调研员 / 实施员 / 校验员 / 撰写员四个员工包，外部插件可用同一 `employeePack` 工厂安装新角色；`GET /api/employees` 与工作台「已安装员工包」展示五件套。
4. `pnpm test`（core 23 + daemon 20）、`pnpm e2e` 均通过。

已完成（v0.7.0）：

1. 验收证据化：新增 `verification` 服务（`verification:run` / `verification:provide`）；`finish()` 不再采信员工自报，command 在 worktree 内重跑、diff 用 git 复算、rubric/human 标记 unverified。
2. 逐条验收：`POST /api/tasks/:id/acceptance` 替代 `/accept`；每条未通过项必须给结论与理由，证据与判定落 `evidence` / `acceptance_records` 两表（旧库自动迁移到 user_version=2）。
3. 阶段视图：`core/stage.ts` 纯计算 `person / working / idle`，`GET /api/tasks?stage=` 与工作台标签消费同一结果。
4. `pnpm test`（core 23 + daemon 22）、`pnpm e2e` 均通过。

已完成（v0.8.0）：

1. 运行中输入：`RuntimeAdapter` 增加 `capabilities` 与可选 `sendInput`，调度器新增 `deliverInput`；运行中立即送达（`input.delivered`），只支持队列的运行时返回 `queued` 并在下次派发时注入，人的消息走快车道不受并发现制；`task_inputs` 落库（user_version=3）。
2. 规则监察：新增 `supervisor` 服务与 `supervisor.rules` 插件；`core/supervision.ts` 纯规则判断越权/空转/心跳/重复/停滞/预算/长尾，动作写入 `supervision_actions` 并进入回放；同一规则重复触发升级暂停；`empty_completion` 在完成时直接判失败，不进入验收。
3. `pnpm test`（core 27 + daemon 24）、`pnpm e2e` 均通过。

已完成（v0.9.0）：

1. 验收闭环：`AcceptancePolicy`（`auto` / `unverified_only` / `always_human`）+ `DeliverableProfile`（`code` / `document` / `dataset` / `design` / `ops`）+ 纯函数 `ProvenanceVerifier`；`verification` 支持 `assertion` / `anchor` / `provenance` 三类证据并按 `evidence_required` 绑定判定，非 Git 交付物也有自动预验路径；四个员工包默认验收标准移除 `human`。
2. 内容级 diff：`diff` 复算改为 `paths` + 完整 patch `sha256` + 增删行数三者比对，任一不一致即 failed，不再只看行数。
3. 委派结构断言：`validateDelegation` 在 `tickProject` 实际调用；根任务 plan 少于 2 个子任务返回 `PLAN_NOT_DECOMPOSED`，其余结构问题返回 `PLAN_INVALID`。
4. 租约与授权链（G5/G6）：`runs` 新增租约字段（`status` / `lease_owner` / `lease_expires_at` / `last_heartbeat_at`），调度器 tick 续租并回收过期运行，孤儿运行标记、失败 worker 与输入注入后重派；`task_mandates` 落库，派单前校验 `MANDATE_INVALID`，运行中每次工具调用校验越权并落 `mandate.denied`；旧库自动迁移到 user_version=4。
5. `pnpm test`（core 35 + daemon 28）、`pnpm e2e` 均通过。

已完成（v0.10.0）：

1. 能力化授权：`TaskMandate` 改为 `capabilities` + `root` + `roles`，不再枚举写路径；员工包 `permissions` 改为 `capabilities`（`fs.read` / `fs.write` / `net.read` / `net.send` / `proc.spawn` / `secrets.use`），安装前由 `GET /api/employees/:id/capabilities` 展示与项目边界的差异；派单校验角色编制，工具调用校验能力、根目录与写域。
2. 项目授权三问：项目新增 `allowNetwork` / `allowExternalSend`，创建时只问工作目录、能否联网、能否外发；默认允许联网读取、禁止外发，员工能力与项目边界取交集后写入 Mandate。
3. 副作用台账：新增 `core/side-effect.ts` 与 `side_effects` 表；`fs.write` / `fs.delete` / `proc.exec` / `net.send` 在工具调用边界先落 `pending`，`tool_result` 结算，审批拒绝记 `rejected`；幂等键 `sha256(taskId + tool + 规范化参数)`，文件写/删与外发去重，`proc.exec` 只记账；`net.send` 一律审批且不可逆。
4. 回放与审计：`GET /api/tasks/:id/side-effects`、`GET /api/side-effects/pending` 与回放 markdown 均包含授权链和副作用台账；旧库自动迁移到 user_version=5（重建 `task_mandates`、新增项目授权列与 `side_effects`）。
5. 静态回退可见：`WorkbenchSnapshot.planner` 暴露规划模式，工作台顶部常驻「规划 · LLM / 静态回退」标识。
6. `pnpm build`、`pnpm test`（core 37 + daemon 28）、`pnpm e2e` 均通过。

已完成（v0.11.0）：

1. 委派与恢复：新增 `DelegationMode`（v1 只接受 `fixed`）并在任务单校验阶段拒绝其他取值；`POST /api/tasks/:id/reassign` 支持把 `failed` / `blocked` 子任务改派给其他编制角色，跨编制自动重签 `TaskMandate` 并落 `task.reassigned`。
2. 孤儿 worktree 清理：调度器重启恢复时对 `done` / `cancelled` 任务移除 worktree，`failed` / `blocked` 保留现场；清理失败落 `worktree.remove_failed`。
3. 工作台：`panel.inbox` 聚合待审批、失败/阻塞子任务、根任务待开工与待验收；任务树新增 DAG 拓扑分层视图与就地重派入口；左中右三列布局。
4. `pnpm test`（core 38 + daemon 29）、`pnpm e2e` 均通过。

已完成（v0.12.0）：

1. 记忆库插件 `memory.store`：提供 `memory` 服务，SQLite + FTS5 为事实来源，Markdown 快照导出到 `memoryDir`；权限拆为 `memory:read` / `memory:write` / `memory:provide`。
2. 写入门槛与冲突处理：来源必需，拒绝临时指令、疑似密钥与过短内容；同键新结论取代旧记忆，重复内容去重。
3. 记忆消费：LLM Planner 注入命中记忆；总管消息固定「我参考了这些记忆」并落 `memory.used`；项目创建时只读标记文件识别技术栈。
4. 记忆检查器与工作台「记忆」页：`GET /api/memory/check`、`GET/POST/DELETE /api/memory`，支持搜索、新增与删除。
5. `pnpm test`（core 38 + memory 11 + daemon 30）、`pnpm e2e` 均通过。

下一步（P3 剩余）：

1. 产物 diff 逐文件审阅、任务模板、首次引导。
2. 进程级插件隔离与 Tauri 2 桌面壳。
