# @opencoxswain/dsh-bao

> ## 🔒 已冻结（2026-11-11）
>
> **产品方向已改为自研整套软件，本包不再演进。**
>
> 当前产品本体：[`apps/runtime`](../../apps/runtime/README.md)（自研运行时）。
>
> 本包保留的价值：
> - **设计参考**：C 常驻根 Agent、D 并行、写域互斥、先完成先报、连发不打断的具体实现与取舍；
> - **行为规格**：`src/test/four-layer.test.ts` 与 `flow.test.ts` 里的测试用例，
>   已被移植到 `apps/runtime/src/test/runtime.test.ts`，行为必须保持一致；
> - `src/executor/gate.ts` 等零依赖纯逻辑已原样移植到自研运行时。
>
> 为什么冻结：legacy `packages/adapters/builtin.ts` 本身已是完整的 LLM
> tool-calling 循环，不需要借助 dsh 验证 Agent 行为；并行维护两套抽象
> （dsh 宿主版 + 自研版）会导致行为漂移。

---

DeepSeek Harness 插件，实现 **A 用户 / B 全局助理 / C 项目助理 / D 执行 Agent** 四层结构。

权威方案：[docs/self-developed-plan.md](../../docs/self-developed-plan.md)
P0 实测记录：[docs/verify/p0-findings.md](../../docs/verify/p0-findings.md)

## 1. 四个角色

| 角色 | 是什么 | 生命周期 | 谁能对它说话 |
| --- | --- | --- | --- |
| **A 用户** | 唯一的人 | — | 对 B、C、D 都能说话 |
| **B 全局助理** | 跨项目路由器，**不执行、不占有项目** | 全局唯一 | 用户 |
| **C 项目助理** | 某个项目的负责人，**常驻根 Agent** | 一项目一 C | 用户、B |
| **D 执行 Agent** | 干具体活的执行者 | 一事一 D，可追问 | C；用户可直连 |

唯一不可让渡的约束：**B 不与 D 直接通信，只与 C 通信。**

## 2. 主推流程

```
用户新建项目 → 插件建项目记录 + 建常驻 C（根 Agent，cwd=项目根）
用户对 C 说："把登录页重构一下"
  └─ C 立刻回一句（不阻塞），然后调 spawn_executor
用户又说（C 还没答完）："顺便看看导出为什么卡住"
  └─ 消息进 C 的 inbox，排队成下一轮，不打断
  └─ C 判断两件事不冲突 → 再开第二个 D，并行
D#1 先完成
  └─ C 立刻向用户汇报 D#1，不等 D#2
D#2 卡住
  └─ C 按卡点分类自己先推进；真要问用户时只问一件
```

## 3. 目录

```
src/
  index.ts                 # 装配：配置 → 宿主探测 → domain → 角色 → 工具
  config.ts                # 配置与默认值（含超配额告警）
  domain.ts                # project / executor / turn / report 四张表
  store.ts                 # 四张表之上的薄封装（事实，不是队列）
  host.ts                  # 宿主能力边界（agents / subagents / storageDomain / tools）
  host-types.ts            # 宿主 Agent 的最小结构类型
  project/tools.ts         # open_project / list_projects（第一步：接入项目）
  assistant/
    lifecycle.ts           # C：create / resume / get / dispose
    tools.ts               # C 的五个工具
    judge.ts               # 冲突判定（并行 / 冲突）
  executor/
    gate.ts                # 并发闸门 + 写域互斥 + FIFO
    runner.ts              # D 的派发、结算、卡点分类
    reporter.ts            # 先完成先汇报 + 去抖合并
  global/tools.ts          # B 的三个工具
  inbox/queue.ts           # 连发不打断
  test/
```

## 4. 工具一览

**项目（用户入口）**

| 工具 | 作用 |
| --- | --- |
| `open_project` | 新建/打开项目并确保有常驻 C；可从会话恢复 |
| `list_projects` | 列出项目与 C 的状态 |

**C 的五个工具**

| 工具 | 作用 |
| --- | --- |
| `spawn_executor` | 派 D，**立刻返回**；可填 `writeScope` 与 `judged` |
| `message_executor` | 给运行中的 D 追加指令（不打断） |
| `list_executors` | 查本项目 D 的真实状态 |
| `cancel_executor` | 取消一个 D |
| `report_to_user` | 主动向用户汇报 |

**B 的三个工具（多一个都不给）**

| 工具 | 作用 |
| --- | --- |
| `list_projects` | 看有哪些项目、各自在忙什么 |
| `find_project` | 判断话属于哪个项目，**必须给依据** |
| `handoff_to_assistant` | 把用户**原话原样**转交给 C |

## 5. 四条关键机制

### 5.1 连发不打断

dsh 三个入口语义完全不同（P0-T4 已实测）：

| 入口 | 语义 | 什么时候用 |
| --- | --- | --- |
| `followup` | 排队成下一轮，**不打断** | 用户连发的**默认** |
| `steer` | 插到当前轮下一步 | 只有"冲突且必须立刻改方向" |
| `cancel` | 真打断 | 只有用户点停止 |

`inbox/queue.ts` 把这个口径固化下来：默认永不打断，`steer` 不可用时**降级到 followup 而不是 cancel**。

### 5.2 冲突判定 + 写域互斥

C 每收到新消息先自问："这条和我在做的是冲突还是并列？"
- 并列 → 开新 D
- 冲突 → 先 `message_executor` 改指令，改不了再 `cancel_executor` 重开

**工程兜底（L4）**：`spawn_executor` 必须填 `writeScope`。写域相交的 D 排队而不是同时跑；声明不了写域 → 视为与所有写任务冲突，串行。
判定结果落 `TurnRow.judged`，让"C 判错了"可审计。

### 5.3 先完成先汇报（D4）

每个 D 独立结算、独立回调，**不等兄弟**。同一批几乎同时完成的，在 `reportDebounceMs`（默认 800ms）窗口内合并成一条。
C 不在场时汇报照样落库，等 C 恢复后补报。

### 5.4 卡住时 C 主动推进（P4）

`classifyBlock` 按规则分三类：

| 分类 | 判定依据 | C 该怎么做 |
| --- | --- | --- |
| 可自行重试 | 类型错误、测试失败、改错路径 | 换法重试，**不打扰用户** |
| 环境问题 | ENOENT / EPERM / 缺依赖 / 端口占用 | 如实报告 + 修复建议 |
| 需用户决定 | 其余（保守归类） | 收敛成**一个**具体问题 |

## 6. 安装

```bash
pnpm --filter @opencoxswain/dsh-bao build
```

把 `cordis.patch.yml` 的 `bao` 行合进 profile 插件清单，并把
`presets/bao.presets.yml` 的三个 preset 插入 profile。

### 宿主必须提供的四个能力

插件启动时逐项探测，缺哪项就打印**可读原因**：

| 能力 | 来源 | 缺了会怎样 |
| --- | --- | --- |
| `ctx.agents` | `@deepseek-ai/dsh-agent` + `dsh-agent-loop` | 建不出 C，插件功能不可用 |
| `ctx.subagents` | `@deepseek-ai/dsh-subagent` + 后端 | 派不出 D |
| `ctx.storageDomain` | `@deepseek-ai/dsh-storage-domain` + 后端 | **拒绝启动**（不拿内存假装持久化） |
| `ctx.tools` | `@deepseek-ai/dsh-tools` | 工具注册不上 |

### 配置

```yaml
- id: bao
  name: '@opencoxswain/dsh-bao'
  config:
    provider: spawn
    assistantPreset: project-assistant
    executorPreset: task-executor
    maxConcurrentExecutors: 5      # 不得超过 dsh 的 maxActiveSubagents（默认 8）
    maxReportChars: 8000
    reportDebounceMs: 800
    maxAutoRetries: 1
```

## 7. 刻意做出的取舍

| 取舍 | 原因 |
| --- | --- |
| C 用 `create`（不传 `parentAgent`）而不是 `startActivation` | C 必须是常驻根 Agent，不是某次 activation 的子代理 |
| 完成通知不手工注入 | dsh 的 `delivery:'parent'` 自己投递（P0-T2），重复注入会双份 |
| D 的 preset 禁止"用发消息结尾" | 否则收尾结论被 `omitClosingText` 省略，C 看不到（L6） |
| 重启把 `running` 标记为 failed 而非 queued | 子代理随进程死了，`running` 是上一世的记忆 |
| 缺 `storageDomain` 拒绝启动 | 不让"内存模式"假装持久化，避免用户以为状态存住了 |
| 写域互斥与并行上限同批上线 | 只开并行不开互斥，C 判错一次就是两个 D 互相覆盖 |
| 工具按调用方校验角色 | 同一张工具表里 A/B/C 各司其职，靠执行上下文区分，不靠"插件级当前 Agent"缓存 |

## 8. 已知限制（诚实声明）

| # | 限制 | 现状 |
| --- | --- | --- |
| L1 | D 完成后不能"随时切回聊天"，要走冷恢复 | P0-T3 证实可行，但需一次加载；产品措辞已按此调整 |
| L2 | C 是根 Agent，没有父树统一 dispose | 插件在 `dispose()` 里逐个收回，有测试覆盖 |
| L3 | `sendMessage` 要求精确的活发送方 | `message_executor` 以 C 为 sender；用户直连 D 走冷恢复 |
| L5 | dsh 配额超限直接硬失败 | 启动时校验并告警 |
| — | **未在真实 dsh 实例上接线验证** | 当前止于 46 条单测 + 上游 `defineTool` 契约校验 + 全仓 typecheck |

## 9. 验证

```bash
pnpm --filter @opencoxswain/dsh-bao typecheck
pnpm --filter @opencoxswain/dsh-bao build
pnpm --filter @opencoxswain/dsh-bao test
```

测试覆盖：

| 文件 | 覆盖 |
| --- | --- |
| `flow.test.ts` | 主推流程 A→C→D→C 汇报、并行、排队、先完成先报、重启恢复 |
| `four-layer.test.ts` | 写域互斥、冲突判定、连发不打断、卡点分类 |
| `assembly.test.ts` | 装配、缺能力降级、配额告警、关停收敛 |
| `tools.contract.test.ts` | 8 个工具能被上游真实 `defineTool` 编译 |
