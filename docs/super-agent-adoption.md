# Super-Agent 架构采纳评估与落地方案

> 面向对象：OpenCoxswain 实现者
> 版本：2026-11-09 / 对应 OpenCoxswain v0.5.0 现状
> 参照物：DeepSeek 产品部 & DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）及开源原型 `deepseek-ai/dsh-superagent-prototype`（MIT，快照 commit `6337fc8`）
> 结论性质：可执行设计，不是综述

---

## 0. 结论摘要

1. **Super-Agent 的权威性在"问题定义 + 系统结构"，不在"产品实现"。** 它把「人的注意力是瓶颈」翻译成了 5 个可验证的系统模块；开源仓库真实落地的是其中 4 个（双层、事件驱动、授权门禁、单一写入者 + Outbox），**存算分离与模型驱动的 Watchdog 没有落地**。
2. **OpenCoxswain 已经等价或部分覆盖了 9 项机制**：双层职责、总管不持执行工具、任务单、DAG 依赖、写域互斥、并发槽位、预算硬停、危险动作闸门、事件 append-only + 回放。
3. **真正要补的是 5 组（6 项能力），按优先级**：
   - **P0 验收证据化**（当前 worker 自报验收，人点「接受」即全部通过，这是最大的可信度漏洞）
   - **P1 运行中投递人消息 + 人的快车道**（当前只能 cancel，不能 steer）
   - **P1 规则版 Watchdog**（当前无停滞/空转/偏航检测）
   - **P2 委派固化在结构里**（当前依赖 planner 输出与总管提示词，缺少结构断言）
   - **P2 任务级授权 Mandate + 租约式断点恢复**（当前只有「危险动作审批」，没有任务级授权链；重启只把 running 一律 blocked）
4. **明确不做 5 项**：云端无状态容器、BYOM 端侧 daemon、Thread 多对多订阅、Inline & Spill 上下文管理、投机执行。理由见 §6，均为「与 Windows 本地优先/插件化目标冲突」或「成本收益不成立」。
5. 版本节奏（按可行性评审 §3.2 重排）：`v0.9.0`（验收闭环：AcceptancePolicy + DeliverableProfile + ProvenanceVerifier + 内容级 diff，含已完成的 G5/G6 基础）、`v0.10.0`（授权与副作用：SideEffect + Mandate 越权拦截）、`v0.11.0`（委派与恢复：DelegationMode + 孤儿 worktree 清理与重派）、`v0.12.0`（记忆层）、`v0.13.0`（Tauri 2 桌面壳与 NSIS 安装包）。全部为新增能力，按 SemVer 升 minor。

---

## 1. Super-Agent 架构逐模块拆解

### 1.1 问题定义（原文第 1 节）

四个基础特征：**连续、高效、主动、持久**。
核心判断：*"单任务的上限取决于模型能力，多任务的上限取决于人的注意力"*；一个人通常只能同时跟进 **3～5 个活跃 Session**。

这解释了为什么它不是「多 agent 框架」而是「Agent 操作系统」：Session 应当是实现细节，不应是用户的认知负担。

### 1.2 五个支撑模块与对应机制

| 模块 | 解决的问题 | 关键机制 | 在原型中是否落地 |
| --- | --- | --- | --- |
| 双层架构（§2） | 连续 vs 吞吐 | Router 常驻、不干活、不配 Bash；Worker 隔离、不直接对外 | ✅ 落地 |
| 事件驱动（§3） | 主动性 | Trigger、Fast/Slow 两级过滤、Thread 订阅直通、Inline&Spill+链式召回、投机执行 | ✅ 前三项；❌ 投机执行未做 |
| 面向人的交互（§4） | 连续 + 高效 | 异步 `start()/stop()`、多信道差异化输出、安静（≤100 词） | ⚠️ 部分（异步命令已做，start/stop 工具未做；多信道仅 GitHub/飞书） |
| 存算分离（§5） | 跨设备持久 | 计算无状态/状态入库/执行环境接入 | ❌ 仅本地 SQLite，Agent Loop 仍在本机 |
| Watchdog（§6） | 异常自愈 | 主系统外的独立 Control Loop，定时消息驱动，模型判断进展与偏航 | ❌ 未以文中形态实现（仅运维侧每小时脚本巡检） |

### 1.3 双层架构的真实边界

**Router 层**（原文 §2.1）：

- 承接所有人类交互，是全局的**序点、协调点、记忆**；
- **不直接执行具体任务**，甚至可以不配 Bash；
- 任务是「任务之间的高层关联与分派」，不介入单任务内部拆解；
- 可以用轻量模型；
- 单 Session 不会成为瓶颈，因为上一轮推理期间到达的 Trigger 会积压并在下一轮**批处理**合并注入（Prefill 阶段并行，单次请求耗时增长远慢于批量）；
- 规模再大时，Router 内部可做多层过滤或**水平切分**——切得越细吞吐越高，但跨片记忆连续性越低。

**Worker 层**（原文 §2.2）：

- 上下文隔离，挂载完整执行工具，通常配最强模型；
- **不直接与人类交互**，只向 Router 汇报，由 Router 统一回复；
- Worker 之间通常不直接通信；冲突靠**共享 Thread 的订阅**自然发现（如两个 Worker 都订阅同一个 PR）；
- 每个 Worker 内部还可以再建 Subagent 或 Agent Team，对 Router 透明。

> **设计意图的精确表述**：这不是「Team Lead + 成员」的团队协作，而是「调度台 + 独立工位」。原文明确对比：常见 Agent Team 的 Lead 要深入任务细节、承担很重的推理负载；Super-agent 的 Router 只做任务间分派。

### 1.4 事件驱动四件事

1. **两级过滤**：程序层 Fast Path（来源、群组、白名单）先筛；语义层 Slow Path（LLM + 提示词策略）只裁语义。哲学是「**规则没允许的，不动**」。
2. **订阅与直通**：Thread（同一 PR / IM 话题 / 邮件串）与 Worker 是**多对多**订阅；已订阅事件由程序直通，不经 Router。Router 只处理无人订阅的新事件。
3. **Inline & Spill**：把上下文窗口当 Cache 管理。先给 ID + 摘要；按局部性逐步内联相邻内容；超限则截断并保留续读入口。统一作用于 Trigger/Thread/Session 后形成**链式召回**（引用图：每条消息内联下一跳的 ID 与摘要）。
4. **投机执行**：分支预测的 Agent 版，用后台算力换人的等待；结果有价值就交付，没价值丢弃。

### 1.5 存算分离的真实内容

三样东西默认绑在一台设备上：**推进 Loop 的计算 / 需要持久化的会话状态 / 代码仓库与本地工具链**。

两步解耦：

- 计算与状态分离：Loop 无状态化，放云端弹性容器；Session 状态入库；容器可重启/替换，连续性由存储保障。
- 计算与执行环境分离：本机通过端侧 daemon 接入，支持 BYOM（Bring Your Own Machine）；机器重新上线后，云端补跑需要它执行的任务。

> 原文只说「思路与脑手分离一致，区别是首先要接用户日常使用、可能间歇在线的个人机器」。

### 1.6 Watchdog 的真实内容

- 主系统**外部**的独立 Watchdog Session，定时消息驱动，构成外部 Control Loop；
- 两类职责：基础设施故障（接口报错、状态恢复失败）+ **模型判断 Worker 是否有实质进展、方向是否偏离整体目标**；
- 发现异常及时介入；外部偶发故障持续复查直至恢复；
- 它自己也是完整 Agent：维护者可用自然语言问故障原因，甚至让它在线增删提示词、调整触发规则。

> **这句是整篇文章里最容易被误读的**：Watchdog 不是「健康检查」，而是「**带工具的第二大脑，监察第一大脑是否在有效工作**」。

### 1.7 文章 vs 代码：必须区分的三层

| 层次 | 内容 | 可验证性 |
| --- | --- | --- |
| 文章级 | 五模块完整设计、投机执行、存算分离、模型驱动 Watchdog、实验数据 | 只能作为设计参照；部分为 future direction |
| 仓库级 | Source 插件（GitHub/飞书）、Trigger/Thread/Eval/Ticket/Mandate、两级过滤、订阅直通、Inline&Spill、单一写入者 + Outbox、SQLite 状态、并发槽位、观察模式、无等待守卫 | 可运行、可复现（单仓库） |
| 产品级 | 无 | README 明写 *"not an official DeepSeek product"* |

**逐项判定（据官方 9 篇文档 + 仓库深读）**：

| 机制 | 文章 | 仓库 | 说明 |
| --- | --- | --- | --- |
| Router/Worker 双层 | ✅ | ✅ | Router 为单个常驻 LLM Session；Worker 为每 Ticket 一个 Session + 独立目录 |
| Router 不配 Bash / 永不等待 | ✅ | ✅ | `noWait` 守卫：出现 `sleep`、Shell 超时 >30s、任务等待 >5s 直接拒绝 |
| 两级过滤 | ✅ | ✅ | Gate 纯代码；Eval 走模型 |
| Thread 订阅直通（多对多） | ✅ | ✅ | 订阅表 + RPC 成员同步；投递绕过 Gate，不授予新权限 |
| Inline & Spill / 链式召回 | ✅ | ✅ | 有明确长度上限与续读入口 |
| 投机执行 | ✅ | ❌ | 无对应模块 |
| 异步 `start()/stop()` | ✅ | ⚠️ | 工具未做；用「前台命令 5s 转后台 + 完成唤醒」达到全双工 |
| 多信道差异化输出 | ✅ | ⚠️ | 仅 GitHub / 飞书两种；100 词上限在提示词里 |
| 存算分离 / BYOM | ✅ | ❌ | 状态本地 SQLite；Loop 本机；端侧 daemon 未实现 |
| Watchdog | ✅ | ❌ | 无模型驱动 Watchdog；仅运维侧每小时巡检任务 + 状态脚本 |
| 授权链 Gate + 不可变 Mandate | ✅ | ✅ | `off / observe / auto` 三档，默认 observe；显式请求在任何模式有效 |
| 单一写入者 + 先存后做 | ✅ | ✅ | Engine 是唯一写入者，领域层不做 I/O；副作用先入队列、提交后执行、失败退避重试 |
| 幂等 ID | ✅ | ✅ | 由输入确定性派生，同一条消息只生成一个工单 |
| 并发槽位给人留快车道 | ✅ | ✅ | 槽位满时，人的消息可额外占一个槽位，且唤醒优先于新工单启动 |
| 诚实交付 | ✅ | ✅ | PR ≠ ready；草稿标未完成；UI 改动无改动前截图不得报 ready |

### 1.8 原型代码结构（模块级）

据 `docs/007-architecture.md`：

```
Source plugins ──SourceContext──▶ Engine ◀── Session tools
                                  │  ▲
              Management routes ──┘  │
                                  ▼
   Store(Repositories) / Policy / SourceScope(Registry)
        / Assessor(MasterAssessor) / Executor(DshExecutor) / Outbox
                                  │
                                  ▼
                        Effects → Store（事务后执行）
```

- **Engine**：唯一写入者，持有领域规则；不做 I/O。
- **Store / Repositories**：状态持久化。
- **Policy**：策略版本；`policyChanged` 通知 Engine。
- **SourceRegistry / SourceScope**：插件化的事件源与作用域。
- **MasterAssessor**：做 Eval 决策（accept with Mandate / stop / ignore）。
- **DshExecutor**：执行 Assignment，回调 `assignmentStarted / inputsDelivered / report`。
- **Outbox / Effects**：事务内先写副作用，提交后执行。
- **Sessions**：Router Session 与 `worker-<ticket id>`。
- **Panel**：Overview / Source / Trigger / Eval / Execution / Settings，第一屏回答「现在有没有需要我做的事」。

**领域模型（docs/001）**：`Source → Trigger → Thread → Eval → Ticket(+Mandate) → Assignment → Executor → Report → Channel`；`Subscription` 是 Thread 与 Ticket 的多对多关系。

**执行阶段（docs/003，按优先级匹配）**：person/delivery → person/answer → person/review → person/blocked|failed → working/queued → idle(waiting for a trigger) → working。

> 这张阶段表比我们的 11 个状态更有信息量：**它表达的是「现在在等谁、等什么」，而不是「任务处于哪个状态」**。这是我们最该抄的产品结构之一。

---

## 2. OpenCoxswain 现状（以代码为准）

### 2.1 已有的等价物

| 能力 | 当前实现 | 位置 |
| --- | --- | --- |
| 双层职责 | `steward` 负责对话/汇总/验收；`planner` 出任务单；`scheduler` 派发；runtime 执行 | `apps/daemon/src/{steward,planner,scheduler}.ts` |
| 总管不持执行工具 | 白名单仅 5 个：`spawn_worker / assign_task / query_worker / collect_result / ask_human` | `steward.ts` |
| 任务单 | `TaskContract`（含 `acceptance_criteria / dependencies / write_scope / budget / review`）持久化到 `contract_json` | `packages/shared/src/types.ts:73` |
| 任务树 | `parentId` + `task_edges`；`settleRoots()` 在子任务全部 settled 后把 root 推到 `awaiting_review` | `scheduler.ts:239` |
| 结构固化分工（部分） | root 不直接派 worker（`task.parentId === null` 跳过）；planner 只校验 `Array.isArray(subtasks)`，**未校验非空** | `scheduler.ts:213` / `planner-llm.ts:123` |
| DAG + 写域互斥 | `readyTaskIds()`；`hasWriteConflict()`；verifier 只读 | `packages/core/src/dag.ts` |
| 并发槽位 | 全局 `maxConcurrency`（默认 2）+ 项目级上限 | `scheduler.ts:172` |
| 预算 | 70% 警告、100% 硬停；运行中按 `cost` 事件实时累计；项目日预算 | `scheduler.ts:607` |
| 危险动作闸门 | 5 类（delete/push/publish/pay/external_send）建 `approvals`；支持 gate 的运行时动作前冻结 | `scheduler.ts:534` |
| 事件 + 回放 | `events` append-only；`/api/tasks/:id/replay?format=markdown` | `storage` / `api-rest.ts` |
| 验收判定入口 | `steward.acceptTask()`：`command/diff` 未验证则 409；`human/rubric` 自动置 `passed`，证据固定为「用户验收通过」 | `steward.ts:333` |
| 插件内核 | 17 个内置清单；`provides/inject/permissions` 拓扑加载；外部 `plugin.json` | `apps/daemon/src/kernel/`、`plugins/manifests.ts` |
| 重启恢复 | `recover()`：把 `running` 一律改 `blocked`，worker 标 `failed` | `scheduler.ts:160` |

### 2.2 与 Super-Agent 的真实差距（按严重度）

| # | 差距 | 现状证据 | 后果 |
| --- | --- | --- | --- |
| G1 | **验收由执行者自证** | `finish()` 直接采用 `result.acceptance`；全 passed 即 `done`，无人工环节 | 员工说「我过了」就算过；`human` 门槛可被绕过 |
| G2 | **人工验收是批量盖章** | `acceptTask()` 对 `human/rubric` 一律写 `passed`，证据固定为「用户验收通过」 | 无法回答「哪一条、凭什么、谁验的」 |
| G3 | **无法向运行中的员工追加输入** | `RuntimeAdapter` 只有 `createSession/send/cancel/pause/resume`，无 `sendInput`；API 无任务级 input 端点 | 人只能 cancel 后重来；违反「连续」特征 |
| G4 | **无停滞/空转/偏航检测** | 代码中无 heartbeat/stall/progress 判定；`progress` 事件只记录不消费 | 员工卡死只能靠预算烧完或人肉发现 |
| G5 | **重启即中断** | `recover()` 把 running 全改 blocked，无租约、无孤儿检测、无断点续跑 | 夜间长任务被 daemon 重启打断；与「持久」冲突 |
| G6 | **授权粒度只有动作级** | `approvals` 只覆盖 5 类危险动作；无任务级 scope/期限/授权凭证 | 无法回答「这个任务被授权动哪些目录、哪些命令、到什么时候」 |
| G7 | **阶段不可读** | 11 个状态只表达「处于哪一步」，不表达「在等谁」 | 面板无法做到「第一屏只显示需要我做的事」 |

---

## 3. 采纳映射总表

> 判定：**等价**＝已做到且语义一致；**补**＝需新增；**改造**＝已有但语义不足；**不做**＝明确不采纳。

| # | Super-Agent 机制 | OpenCoxswain 现状 | 判定 | 落点 |
| --- | --- | --- | --- | --- |
| M1 | Router/Worker 双层 | steward 对话 + planner 拆解 + scheduler 派工 + runtime 执行 | 等价（缺常驻） | 不新增角色；见 §5.5 的 `stage` 视图 |
| M2 | Router 不干活、不配 Bash | 总管白名单无 shell/文件工具 | 等价 | — |
| M3 | Router 批处理 Trigger | 无外部高频事件源，请求-响应式 | 不做 | 未来 M4 Source 再评估 |
| M4 | Fast/Slow 两级过滤 | 无 Source 概念 | 不做（预留） | 若做 M4，新增 `source.*` 插件；见 §6 |
| M5 | Thread 订阅直通 | 用 `task_edges` 表达依赖；事件总线广播 | 改造（轻量） | 子任务完成 → 父任务事件已足够；不引入 Thread |
| M6 | Inline & Spill / 链式召回 | 运行时（OpenCode）自管上下文；我们只传 contract + artifacts | 不做 | — |
| M7 | 投机执行 | 无 | 不做 | 成本不可控，本地机器不划算 |
| M8 | 异步 start/stop、多信道 | 有 cancel/pause/resume；仅 HTTP/SSE | 改造 | §5.2 输入注入 + 快车道 |
| M9 | 存算分离 | 状态 SQLite、执行 worktree、计算在本机 | 改造（最小版） | §5.4 租约 + 孤儿恢复；不做云容器 |
| M10 | Watchdog 外部 Control Loop | 无 | 补 | §5.3 `supervisor.watchdog` 插件 |
| M11 | 授权链 Gate + 不可变 Mandate + observe | 动作级 approvals；无任务级授权 | 补 | §5.5 `TaskMandate` |
| M12 | 单一写入者 + Outbox + 幂等 ID | Engine 式 store + append-only events；无 outbox | 改造（轻量） | §5.6 `side_effects` 表 |
| M13 | 并发槽位给人的快车道 | 有并发与预算；无「人的消息插队」 | 补（随 M8） | §5.2 |
| M14 | 诚实交付（PR≠ready） | 无硬约束，仅靠 prompt | 补 | §5.1 验收证据 + 提示词硬规则 |
| M15 | 「在等谁」阶段模型 | 11 个状态 | 改造 | §5.1 `stage` 计算视图 |

---

## 4. 采纳原则（三条，后续所有改动都受其约束）

1. **结构优先于提示词**。凡是「必须发生」的行为（拆分、验收、授权、停止），都要有代码断言；提示词只负责「怎么做得更好」。
2. **证据优先于自述**。执行者的输出只是候选；进入 `done` 之前必须有系统可复核的证据。
3. **人的注意力是预算**。任何新增通知、面板字段、审批项，都必须能回答「不做这个决定会怎样」；回答不了就不加。

---

## 5. 要补的五项：落点、契约、验收

### 5.1 P0 验收证据化（AcceptanceRecord）

**问题**：`finish()` 采信 `result.acceptance`；`acceptTask()` 批量盖章。验收对象只有一对 `criterionId/status/evidence`，没有「证据从哪来、谁验的、能不能复现」。

**与 PRD 的关系**：PRD 已定义「Review：校验员独立复跑验收标准；输出通过/失败/未验证」，也定义了「逐条判定」。本节不是新增产品概念，而是**把 PRD 的约定变成调度器强制路径**——当前代码里没有接线，校验员角色是可选员工，不跑也不会阻止 `done`。

#### 5.1.1 类型改动

`packages/shared/src/types.ts`：

```ts
export type EvidenceKind = 'command_output' | 'diff_stat' | 'file' | 'screenshot' | 'link';
export type Verdict = 'passed' | 'failed' | 'unverified';

/** 一条可复核的证据。执行者只能"提交"，不能"判定"。 */
export interface Evidence {
  id: string;
  criterionId: string;
  kind: EvidenceKind;
  /** command: 命令行；diff: base/head；file: 路径；screenshot: 路径 */
  ref: string;
  /** 命令输出摘要 / diff 统计 / 文件 sha256 */
  digest: string;
  /** 由谁产生：verifier 独立执行，或 worker 提交后由系统复算 */
  producedBy: 'system' | 'verifier' | 'worker';
  createdAt: number;
}

export interface AcceptanceRecord {
  criterionId: string;
  verdict: Verdict;
  /** 每条都必须有；human 类型是"人的判断理由"，command 类型是输出摘要 */
  evidenceIds: string[];
  judgedBy: 'system' | 'verifier' | 'human';
  /** human 时必填：验收人标识 */
  judgedByUser?: string;
  note?: string;
  at: number;
}

export interface AcceptanceCriterion {
  id: string;
  type: AcceptanceType;
  desc: string;
  check?: string;
  /** 新增：该条必须提供哪些证据；缺省由 type 推导 */
  evidence_required?: EvidenceKind[];
}
```

`AcceptanceResult` 保留为「worker 自报的运行期结果」，但**不再直接写库到 `acceptance` 表**；改为写入 `worker_reports`（或 `events` 派生），由验证环节转成 `AcceptanceRecord`。

#### 5.1.2 判定责任

| 类型 | 谁来判 | 规则 |
| --- | --- | --- |
| `command` | **系统**（verifier 进程） | 调度器在 worktree 内独立重跑 `check`；退出码 0 → passed；输出 hash 入证据。**禁止**采信 worker 自报 |
| `diff` | **系统** | `git diff --numstat` 复算统计，并用 `--name-only` 与完整 patch hash 做内容级比对；统计/路径/patch 任一不一致 → `failed` |
| `rubric` | **系统按证据绑定**，必要时 verifier 角色 | `evidence_required` 齐备 → passed；缺证据 → unverified；`anchor` 无法解析 → failed；verifier 不能改代码 |
| `human` | **人** | 必须逐条给 verdict + note；不允许「一键全过」 |

#### 5.1.5 交付物形态与自动预验

- `TaskContract.deliverable_profile: 'code' | 'document' | 'dataset' | 'design' | 'ops'`，员工包声明默认值，Planner 可覆盖。
- `TaskContract.acceptance_policy: 'auto' | 'unverified_only' | 'always_human'`，默认 `unverified_only`：系统能验完就不打扰人；`auto` 连未决项也放行；`always_human` 保留旧行为。根任务不再固定 `human_accept`，仅在子任务存在未决/失败/取消时进入人审。
- `ProvenanceVerifier`（`packages/core/src/provenance.ts`）：从交付物正文提取 `{{anchor: ref}}`、markdown 链接与「来源：」行；锚点缺失 → unverified，锚点无法解析（文件不存在/行号越界）→ failed，锚点齐备且达到数量阈值 → passed。
- 系统证据新增 `assertion`（rubric + check 断言）、`anchor`（锚点及目标摘要）、`provenance`（交付物来源链摘要）。

#### 5.1.3 落点

- 新模块 `packages/core/src/acceptance.ts`：纯函数 `deriveVerdict(criterion, evidence[])`、`requiredEvidenceFor(type)`。
- 新服务 `verification`：`packages/plugin-api/src/contracts.ts` 增加

```ts
export interface VerificationService {
  /** 在指定 worktree 内独立复核；不修改工作区。 */
  verify(input: {
    taskId: string;
    worktree: string;
    criteria: AcceptanceCriterion[];
    artifacts: ArtifactRef[];
  }): Promise<AcceptanceRecord[]>;
}
```

- `provides: ['verification']`，权限新增 `verification:run`、`fs:worktree`（只读约定）、`process:spawn`。
- `scheduler.finish()` 改为：`const records = await verification.verify(...)` → 写 `acceptance_records` → 任一 failed → `failed`；有 unverified → 按 `acceptance_policy` 决定 `done` 或 `awaiting_review`；全 passed 且 policy=`always_human` → `awaiting_review`，否则 `done`。
- `steward.acceptTask()` 拆成 `decideAcceptance(taskId, decisions)`：

```ts
POST /api/tasks/:id/acceptance
{ "decisions": [{ "criterionId": "acc-1", "verdict": "passed", "note": "已人工核对" }] }
```

缺任一条 → 409，并在消息里列出缺失项。**删除** `criterion.type === 'human' || 'rubric'` 自动 passed 的分支。

- 存储：新增 `acceptance_records(task_id, criterion_id, verdict, evidence_ids_json, judged_by, judged_by_user, note, at)` 与 `evidence(id, task_id, criterion_id, kind, ref, digest, produced_by, at)`。保留旧 `acceptance` 表做迁移读兼容（v0.6.0 读旧、写新；v0.7.0 删旧）。

#### 5.1.4 验收（DoD）

- 单测：`human` 未逐条决策 → 409；`command` 退出码非 0 → failed；`diff` 统计或内容 hash 不一致 → failed；`document` 无锚点 → unverified，锚点不可解析 → failed。
- e2e：mock runtime 返回「全 passed」，但 `command` 复核失败 → 任务必须停在 `failed`，且汇总「未通过的检查」列出输出片段。
- 回放 markdown 每条验收项含：标准、证据引用、判定人、时间。
- 面板：`awaiting_review` 行必须显示「3 项待你判断」，点开逐条。

---

### 5.2 P1 运行中投递人消息 + 人的快车道

**问题**：`RuntimeAdapter` 只有 `send`（一次性投递 contract），没有中途输入；人只能 cancel。

#### 5.2.1 契约改动

`packages/adapters/src/adapter.ts`：

```ts
export interface RuntimeCapabilities {
  /** 能否向运行中的会话追加输入 */
  input: boolean;
  /** 是否支持执行前挂起 */
  approvalGate: boolean;
  /** 能否从 checkpoint 恢复 */
  resume: boolean;
}

export interface InputDelivery {
  id: string;
  text: string;
  /** 人 / 系统（watchdog nudge） / 其他任务 */
  source: 'human' | 'supervisor' | 'task';
  at: number;
}

export interface RuntimeAdapter {
  readonly capabilities: RuntimeCapabilities;
  /** 可选实现；capabilities.input=false 时调度器必须拒绝，不得静默丢弃 */
  sendInput?(session: RuntimeSession, input: InputDelivery): Promise<'delivered' | 'queued' | 'unsupported'>;
}
```

同时把 `RuntimeEvent` 增加：

```ts
| { type: 'input_received'; at: number; inputId: string }
| { type: 'heartbeat'; at: number; phase: string; note?: string }
```

#### 5.2.2 调度器行为

- 新表 `task_inputs(id, task_id, source, text, state, created_at, delivered_at)`；状态 `pending / delivered / consumed / rejected`。
- `POST /api/tasks/:id/inputs` body `{ text }`：
  - 任务 `running` 且 adapter 支持 → 立即投递，写事件 `input.delivered`；
  - 任务 `running` 但不支持 → 409，返回 `{"reason":"runtime_no_input","fallback":"cancel_and_requeue"}`，**禁止假装成功**；
  - 任务 `awaiting_review / blocked` → 追加为上下文，下次派发时随 contract 注入；
  - 任务 `done / cancelled` → 409。
- 快车道：`tickProject()` 在检查并发上限前，先处理 `pending` 且 `source==='human'` 的 input；允许超出 `maxConcurrency` 一个槽位（`humanSlot`），且优先于新任务 spawn。
- 预算：人消息触发的唤醒不计入新 run，但消耗仍记在该 task 的 `cost`。

#### 5.2.3 落点

- `scheduler.ts`：新增 `deliverInput(taskId, input)`、`pendingHumanInputs(projectId)`；`tickProject()` 入口先跑快车道。
- `api-rest.ts`：`POST /api/tasks/:id/inputs`，权限沿用 `steward:call`/`storage:write`。
- `runtime-opencode.ts`：实现 `capabilities.input`。OpenCode 桌面 CLI 若不支持 stdin 注入，则实现为「写入 worktree 的 `.opencoxswain/inbox/<id>.md` + 会话内约定读取」并如实标 `queued`；**不得标 delivered**。
- `runtime-mock.ts`：实现回显，用于 e2e。

#### 5.2.4 验收

- e2e：任务 running → POST input → 事件流出现 `input.delivered` → mock 回显该文本 → 任务继续。
- e2e：不支持输入的 adapter → 409，任务状态不变。
- 单测：并发满时，人消息仍能获得一个额外槽位；新任务不能抢占。

---

### 5.3 P1 规则版 Watchdog（`supervisor.watchdog`）

**定位**：采纳「主系统外的独立监察 + 可介入」，但**不采纳**「让模型自由判断、自己改提示词」。我们做**规则判据 + 模型诊断**，因为我们的目标是可解释、可回放、可测试。

#### 5.3.1 监察判据（全部可计算）

| 判据 | 计算方式 | 阈值（可配置） | 处置 |
| --- | --- | --- | --- |
| 无心跳 | `now - last_event_at(run)` | 5 min | nudge |
| 停滞 | 连续 N 个 `tool_call` 无新增 artifact/acceptance/文件变更 | N=8 或 10 min | nudge → pause |
| 重复指纹 | `hash(tool, normalize(input))` 连续相同 | 3 次 | nudge（提示换方法） |
| 预算斜率 | 最近 10 min 成本 / 任务剩余预算 | > 2× 线性预期 | warn → 询问人 |
| 空转完成 | `finished` 但 artifacts 为空且 deliverables 非空 | 1 次 | 直接 failed（不进入 review） |
| 偏航 | 变更文件不在 `write_scope` 内 | 任意一次 | 立即 pause + 审批 |
| 长尾 | 单 run 超过 `budget.minutes` 的 80% | — | warn |

> 最后一条「偏航」是硬规则，优先级最高：它同时是安全边界。

#### 5.3.2 契约

`packages/plugin-api/src/contracts.ts`：

```ts
export type SupervisionVerdict =
  | { kind: 'ok' }
  | { kind: 'nudge'; reason: string; message: string }
  | { kind: 'pause'; reason: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'ask_human'; reason: string; question: string };

export interface SupervisionService {
  /** 纯规则，不得调用 LLM；必须可单测。 */
  inspect(input: {
    task: Task;
    worker: Worker;
    recentEvents: EventRecord[];
    now: number;
  }): SupervisionVerdict;
  /** 可选：用 LLM 生成诊断文本，失败不影响 verdict。 */
  explain?(verdict: SupervisionVerdict, input: unknown): Promise<string>;
}
```

- 插件 id：`supervisor.rules`（纯规则，内置，`provides: ['supervisor']`，权限 `events:read`、`storage:read`）。
- 可选插件 `supervisor.llm`：`inject: ['supervisor']`，只做 `explain`，权限 `secrets:read`。
- 事件：`supervisor.nudged / supervisor.paused / supervisor.failed / supervisor.asked_human`；`events` 表中 `actor='supervisor'`。
- 调度：`tick()` 每 30s 跑一次 `inspect`；**不新增轮询线程**，复用现有 tick，但单独限频。

#### 5.3.3 落点

- 新文件 `packages/core/src/supervision.ts`（纯函数 + 阈值常量）。
- 新插件 `apps/daemon/src/plugins/supervisor-rules.ts`、`supervisor-llm.ts`。
- `scheduler.ts`：新增 `supervise()`，在 `tickProject()` 末尾调用；`nudge` 走 §5.2 的 `sendInput(source:'supervisor')`；`pause` 复用 `pause()`；`ask_human` 写 `messages` 的「## 待你决策」。
- 存储：新增 `supervision_actions(id, task_id, worker_id, verdict, reason, at)`，便于回放。

#### 5.3.4 验收

- 单测覆盖 7 条判据的边界值（含「刚好等于阈值不触发」）。
- e2e：mock runtime 连续 8 次相同 tool_call → 触发 nudge；继续 → pause；事件可回放。
- e2e：写 `write_scope` 之外的路径 → 立即 pause，不进 review。
- 反例测试：正常任务 30 分钟内不得产生任何 supervision 事件（避免误报）。

---

### 5.4 P2 委派固化在结构里

**问题**：现在「拆不拆」由 planner 的 LLM 输出决定，总管也只是被 prompt 约束。DeepSeek 实验证明：中性提示下 5 次 0 次委派。我们必须让「不拆」成为非法状态。

#### 5.4.1 结构断言

在 `scheduler.spawn()` 之前增加断言（`packages/core/src/delegation.ts`）：

```ts
export interface DelegationPolicy {
  /** 非平凡任务的判定：goal 字符数 / 是否跨文件 / 是否含多动词 */
  isTrivial(task: TaskContract): boolean;
  /** 非平凡任务必须有子任务，且角色覆盖 */
  validate(root: TaskContract, children: TaskContract[]): string[];
}
```

规则：

1. 非平凡 root 必须有 `children.length >= 1`；否则 root 不能进入 `queued`，转 `blocked` 并产出「## 待你决策：计划未拆分」。
2. 每个 child 必须有 `assignee.role`，且角色至少覆盖 `implementer`；涉及校验的必须有 `verifier` 子任务或 `review.required=true`。
3. `assign_task` 工具**只能修改已有 child 的 `assignee`**，不能创建新任务、不能改 `acceptance_criteria`；创建只能走 planner。人通过 API/UI 修改任务单仍然允许（PRD 明确保留「换验收标准」），但必须 bump `plan_revision` 并记 `plan.updated` 事件，以便回放区分「谁改的」。
4. `TaskContract` 增加 `plan_id: string` 与 `plan_revision: number`；planner 输出必须带；同一 `plan_id` 下增删子任务会 bump revision（用于回放与审计）。

#### 5.4.2 契约改动

`TaskContract`：

```ts
plan_id: string;
plan_revision: number;
/** 谁决定的分工：planner = 结构派生；user = 手动；steward = 仅调整执行者 */
delegated_by: 'planner' | 'user' | 'steward';
```

Planner 侧改动（`planner-llm.ts`）：

- `draft()` 解析后：`raw.length === 0` 直接 `throw`，触发静态回退（当前只校验 `Array.isArray`，空数组会被放行）；
- 每个子任务 `role` 必填；`normalizeSubtasks` 后跑 `validate()`，失败则不进入 `engine.plan`；
- **不允许**「直接返回 root」；`request.subtasks` 为空时由静态拆分兜底。

`scheduler.spawn()` 侧再断言一次（双保险）：非平凡 root 的 `children.length === 0` → `blocked` + `PLAN_NOT_DECOMPOSED`，不允许进入 `running`。

#### 5.4.3 验收

- 单测：非平凡 goal 产出 0 个子任务 → `blocked`，错误码 `PLAN_NOT_DECOMPOSED`。
- 单测：`assign_task` 试图创建任务 → 抛 `FORBIDDEN`。
- 指标：`delegation_rate = 有子任务的 root / 全部 root`，e2e 断言 100%（平凡任务白名单除外）。
- 回放：`plan_id` + `plan_revision` 出现在 markdown 头部。

---

### 5.5 P2 任务级授权 Mandate + 「在等谁」阶段视图

#### 5.5.1 TaskMandate

**问题**：现在只有 5 类危险动作审批；没有「这个任务被授权做什么」的凭证。DeepSeek 的核心洞察是：**权限与内容隔离**——消息只能影响「怎么干」，不能改变「为什么被授权」。

```ts
export interface TaskMandate {
  id: string;
  taskId: string;
  /** 能力集合：fs.read / fs.write / net.read / net.send / proc.spawn / secrets.use */
  capabilities: Capability[];
  /** 授权根目录（项目工作目录）；写入不得越出 */
  root: string;
  /** 允许执行该任务的员工角色；跨编制改派必须重签 */
  roles: RoleName[];
  /** 预算与截止，防止无限扩权 */
  budget: Budget;
  expiresAt: number;
  /** 签发依据：哪条用户消息 / 哪次审批 */
  issuedBy: 'user' | 'approval';
  issuedAt: number;
}
```

规则：

- Mandate **不可变**；扩权或跨编制改派必须新建 Mandate（或走审批），旧凭证不改。
- 每个 `spawn` 前校验：`assignee.role ∈ roles`，否则 `MANDATE_INVALID`；每次 `tool_call` 校验能力、绝对路径不越 `root`、相对路径不越 `write_scope`，否则拒绝并记 `mandate.denied`。
- 恢复/重派前**重验** Mandate（过期即拒绝），不信任上次状态。
- `net.send` 即使已在 `capabilities` 内，也必须逐次审批，且副作用标记为不可逆。
- 事件：`mandate.issued / mandate.denied / mandate.expired`。

落点：`packages/core/src/mandate.ts`、`steward.ts`（签发）、`scheduler.ts`（校验）、`api-rest.ts`（`GET /api/tasks/:id/mandate`）。权限新增 `mandate:read`（面板）/`mandate:issue`（steward）。

验收：单测「写 root 外路径 → denied」「能力缺失 → denied」「过期 Mandate → spawn 失败」「跨编制改派 → 重签」；e2e 回放含授权链与副作用台账。

#### 5.5.2 阶段视图（不改状态机）

在 `packages/core/src/stage.ts` 增加**计算视图**（不落库、不改状态）：

```ts
export type TaskStage =
  | { kind: 'person'; reason: 'answer' | 'review' | 'blocked' | 'failed'; detail: string }
  | { kind: 'working'; reason: 'queued' | 'running' }
  | { kind: 'idle'; reason: 'waiting_dependency' | 'waiting_input' };
```

映射规则（按优先级）：有 `pending` 的 human input → person/answer；`awaiting_review` → person/review；`blocked` → person/blocked；`failed` → person/failed；`queued` → working/queued；`running` → working；依赖未满足 → idle/waiting_dependency。

用途：

- 面板首页只查 `stage.kind === 'person'`，天然实现「现在有没有需要我做的事」。
- API：`GET /api/tasks?stage=person`。
- **不新增数据库状态**，避免状态机膨胀。

验收：11 个状态 × 依赖组合的属性测试，保证映射全覆盖且互斥；面板首屏 e2e 只显示 person 项。

---

### 5.6 P2 租约式断点恢复（存算分离的最小版）

**问题**：`recover()` 把 running 一律 blocked，长任务被重启打断。

**立场**：我们**不做**云端无状态容器与 BYOM（见 §6），只做「**本地存算分离的最小可信版**」：状态已在 SQLite，执行现场在 worktree；补的是**谁在跑、跑到哪、能不能续**。

#### 5.6.1 契约

```ts
export interface RunLease {
  runId: string;
  owner: string;          // daemon instance id
  expiresAt: number;      // now + 30s
  lastHeartbeatAt: number;
}

export interface StorageService {
  claimRun(runId: string, owner: string, ttlMs: number): boolean;
  renewLease(runId: string, owner: string, ttlMs: number): boolean;
  releaseRun(runId: string): void;
  listExpiredRuns(now: number): Array<{ taskId: string; runId: string; workerId: string }>;
}
```

- `RuntimeEvent` 的 `heartbeat`（§5.2）驱动 `renewLease`；没有 heartbeat 的 adapter 用 `tool_call/message/cost` 事件兜底续约。
- `recover()` 改为：
  - 租约未过期 → 保留 `running`，标记 `recovered_unknown`，由 supervisor 观察；
  - 租约过期 → `run.status='orphaned'`，任务回 `queued`，**复用 run 记录**（不新建，避免重复计费），并注入一条「上次执行被中断」的上下文。
- `RuntimeAdapter.capabilities.resume` 为 true 时，优先 `resume(session)`；否则重派并附 checkpoint（`TaskContract.checkpoint?: string`，由 adapter 自行解释，通常是一个 worktree 快照/分支）。

#### 5.6.2 落点

- `packages/shared/src/types.ts`：`Run` 增加 `leaseOwner / leaseExpiresAt / lastHeartbeatAt / status: 'running'|'orphaned'|'done'|'failed'`。
- `storage` 增 4 个方法 + 索引 `runs(lease_expires_at)`。
- `scheduler.ts`：`start()` 先 `recover()`；每 tick 续约当前 active runs；`listExpiredRuns` → `orphan()`。
- `api-rest.ts`：`GET /api/runs/orphaned`（调试用）。

#### 5.6.3 验收

- e2e：任务 running 时 kill daemon → 重启 → 租约过期 → 任务回 `queued` 并自动重派；`model_calls` 不重复计数。
- e2e：租约未过期（模拟另一个实例持锁）→ 不抢跑。
- 单测：`claimRun` 并发只有一个成功；`renewLease` 过期后失败。

---

## 6. 明确不做清单（及理由）

| 项 | 为什么不做 | 替代 |
| --- | --- | --- |
| 云端无状态容器 + 会话状态入库 | 与「Windows 本地优先 + 数据不出机器」的核心定位冲突；单人维护成本过高 | §5.6 本地租约 + 断点恢复 |
| BYOM / 端侧 daemon | 需要云端控制面与设备身份体系；v1 前不成立 | 同一台机器 daemon 常驻 + 开机自启（P2 桌面壳） |
| Thread 多对多订阅 | Thread 是为「同一 PR/IM 话题的连续事件」设计的；我们没有外部事件源，`task_edges` 已足够 | 子任务完成事件 → 父任务 `root.settled` |
| Inline & Spill / 链式召回 | 上下文由 OpenCode/Claude 等运行时自管；我们无法也不应介入其窗口 | 只优化 contract 摘要与 artifacts 引用 |
| 投机执行 | 本地算力与 token 成本不可控，且会污染预算账本 | 不做 |
| 模型驱动的 Watchdog 自由改提示词 | 不可测试、不可回放，与「事件可回放」冲突 | §5.3 规则判据 + LLM 仅生成诊断 |
| 两级过滤 Fast/Slow | 无 Source，当前是用户显式请求 | 未来若接 IM/GitHub Issue，再按 §5.3 的规则层先做 Fast Path |

---

## 7. 实施顺序与版本

| 版本 | 内容 | 依赖 | 风险 |
| --- | --- | --- | --- |
| v0.6.0（已发布） | 员工插件包（角色/技能/工具/权限/验收标准五件套），为验收与委派提供可安装载体 | 无 | 与本文档原排期不同：员工包先占用 v0.6.0 |
| v0.7.0（已发布） | §5.1 验收证据化 + §5.5.2 阶段视图 + 诚实交付提示词（G1/G2/G7） | 无 | 已删除旧 `task_acceptance` 表与 `/accept` 入口，旧库自动迁移到 v2 |
| v0.8.0（已发布） | §5.2 输入注入 + 快车道 + §5.3 规则版 Watchdog（G3/G4） | §5.2 的 heartbeat | `task_inputs` 与 `supervision_actions` 落库，旧库自动迁移到 user_version=3 |
| v0.9.0（已发布） | 验收闭环（AcceptancePolicy + DeliverableProfile + ProvenanceVerifier + 内容级 diff）+ §5.4 委派固化 + §5.5.1 Mandate + §5.6 租约与孤儿恢复（G5/G6） | 需要 planner schema 变更、storage 迁移 | `runs` 新增租约字段、`task_mandates` 落库，旧库自动迁移到 user_version=4；`validateDelegation` 接入 `tickProject`，不再有死代码 |
| v0.10.0（已发布） | 能力化 Mandate（capabilities + root + roles）+ 项目授权三问 + SideEffect 台账（先记账后执行、幂等键、net.send 审批不可逆）+ capability diff + 静态回退可见 | §5.5.1 的授权链、storage 迁移 | 员工包 `permissions` 直接改为 `capabilities`，不保留兼容层；`task_mandates` 重建、`side_effects` 落库，旧库自动迁移到 user_version=5 |
| v0.11.0（已发布） | `DelegationMode = fixed` 契约校验 + 任务树重派（跨编制重签 Mandate）+ 孤儿 worktree 清理 + DAG 可视化 + 待决策收件箱 | v0.9.0 的租约与 Mandate、v0.10.0 的副作用台账 | 重派只清理 worktree 后重新执行，不做文件级回滚；`failed` / `blocked` 的 worktree 保留现场 |
| v0.12.0（已发布） | `packages/memory`：SQLite FTS5 + Markdown 快照、写入门槛、同键取代、混合检索、记忆检查器；Planner 注入与总管「我参考了这些记忆」；项目创建识别技术栈 | P3 记忆层目标、§5.6 记忆条目 | 记忆必须带来源；不存临时指令与密钥；Markdown 是导出快照而非事实来源；embedding 后置，不做进程外服务 |
| v0.13.0（已发布） | Tauri 2 桌面壳：Rust 拉起并托管 daemon 子进程、端口就绪后开窗、退出清理；`scripts/package-daemon.mjs` 摊平 daemon 与工作区包产物，NSIS 安装包 | 无（插件契约与加载顺序不变） | 桌面壳只是 daemon 的启动器与展示层，不是沙箱；安装包运行时依赖系统 Node.js >= 22 |

规则：全部是新增能力，按 SemVer 升 minor；若删除旧 `acceptance` 表读取路径，属移除功能，需在 v1.0 前统一处理，不单独升 major。

---

## 8. 总验收清单（跨项）

1. `pnpm test` / `pnpm e2e` 全绿；新增 `pnpm e2e:supervision`、`pnpm e2e:acceptance`。
2. 任意任务从 `draft` 到 `done`，回放 markdown 必须包含：计划（plan_id/revision）、子任务树、每个员工的 run、每条验收标准的证据与判定人、每次 supervision 动作、Mandate。
3. 面板首屏只显示 `stage.kind === 'person'`；每条都能直接操作（回答/验收/重试/取消）。
4. 不存在「员工自报全 passed 即 done」的路径（单测断言）。
5. 不存在「创建任务但不拆分」的路径（平凡任务白名单除外）。
6. 重启后不重复计费、不丢任务、不重复派发（租约测试）。
7. 所有新增事件 actor 明确（`system / supervisor / user / scheduler`），可在 `events` 表按 actor 过滤。

---

## 9. 风险与反模式

1. **把 Watchdog 做成第二个总管**：它会与 steward 抢话语权。约束：supervisor 只能 `nudge/pause/ask_human`，**不能创建任务、不能改任务单、不能替人验收**。
2. **验收证据化变成形式主义**：如果每条都要求截图，人会直接点「全部通过」。约束：按 `type` 推导最小证据集；`command` 自动跑，`human` 只要求一句理由。
3. **输入注入导致上下文污染**：中途消息可能让员工偏离原目标。约束：注入消息带 `source` 与 `mandate` 提示；supervisor 可检测偏航。
4. **Mandate 过严导致什么都干不了**：本地读写与跑命令由员工能力直接授予，项目三问只收窄联网与外发；未声明写域的任务仍按「与所有写任务冲突」处理，不额外加锁。
5. **租约导致双跑**：`claimRun` 必须是数据库层原子操作（SQLite `BEGIN IMMEDIATE`），不能先在内存判断。
6. **阶段视图与状态机双写**：`stage` 必须是纯计算，不落库；否则两套真相必然漂移。

---

## 10. 证据与来源

### 10.1 DeepSeek 一手材料

- 架构文章（转载全文）：[Super-agent 设计探索：迈向更自主的 Agent 系统](http://www.uml.org.cn/ai/202611023.asp)
- 官方仓库：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
- 领域模型：[docs/001-domain.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)
- 授权：[docs/002-authorization.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)
- 执行与阶段：[docs/003-execution.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)
- 面板：[docs/005-panel.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md)
- 架构：[docs/007-architecture.md](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)

### 10.2 对照阅读（二手，用于交叉验证）

- [51CTO：DeepSeek 刚刚开源 Super-agent 架构深度拆解](https://www.51cto.com/article/860077.html)（含「哪些落进代码、哪些没有」的逐项核对）
- [掘金：Super-agent 原型拆解（授权链 / 实验 / Watchdog 未实装）](https://juejin.cn/post/7703531021345996854)
- [51CTO：Super-agent 开源原型深度解读](https://www.51cto.com/article/859970.html)

### 10.3 OpenCoxswain 内部依据

- `docs/plan.md` §5.1–5.7、§6.1
- `docs/plugin-architecture.md` §4–§7、§12
- `packages/shared/src/types.ts`
- `packages/plugin-api/src/contracts.ts`
- `packages/adapters/src/adapter.ts`
- `apps/daemon/src/{scheduler,steward,planner}.ts`
- `apps/daemon/src/plugins/manifests.ts`

---

## 附：一页速查

| 要补的 | 新文件/服务 | 核心契约 | 验收一句话 |
| --- | --- | --- | --- |
| 验收证据化 | `core/acceptance.ts`、`verification` 服务 | `Evidence` / `AcceptanceRecord`；command 由系统重跑 | 员工自报全过也必须被系统复核 |
| 输入注入 | `scheduler.deliverInput`、`POST /tasks/:id/inputs` | `sendInput` / `capabilities.input` | running 中能收到人话，不能假装成功 |
| Watchdog | `core/supervision.ts`、`supervisor.rules` | `SupervisionVerdict` 纯规则 | 卡住/空转/越界都能被发现并留痕 |
| 委派固化 | `core/delegation.ts` | `TaskContract.plan_id/plan_revision` | 不拆分就不能开工 |
| Mandate + 阶段 | `core/mandate.ts`、`core/stage.ts` | `TaskMandate` 不可变；`TaskStage` 纯计算 | 越权必拒；首屏只显示等人的事 |
| 租约恢复 | `storage.claimRun`、`runs.lease_*` | `RunLease` | 重启不双跑、不丢任务 |
