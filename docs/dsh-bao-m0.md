# dsh-bao M0：能用、怎么接、还差什么

> 对应方案：`docs/trae-bao-plan.md` §9 M0。M0 只做**派活 + 回传 + 持久化**三件事。
> 版本：`@opencoxswain/dsh-bao@0.1.0`（私有包，不发布到 npm）。

## 1. 这一版能做什么

| 能力 | 状态 |
| --- | --- |
| `dispatch_task` 一句话派活，立刻返回 taskId，不阻塞 | ✅ |
| 并发闸门 5 + FIFO 队列，第 6 个排队而不是报错 | ✅ |
| 两个项目并行，各自 `cwd` / preset / 父会话互不串台 | ✅ |
| 子代理结算后落报告（`report` 表）并推进终态 | ✅ |
| `list_tasks` 按项目/状态查看全局进度 | ✅ |
| `cancel_task` 取消排队中或运行中的任务 | ✅ |
| 任务状态跨重启保留；残留 `running` 恢复为 `queued` | ✅ |
| 两个 preset：`global-assistant` / `project-driver` | ✅ |

**M0 刻意不做**：记忆、看板 UI、定时推进、IM 网关。它们各自的未实测项（方案 §8 第 1/2/5 项）不要提前耦合进来。

## 2. 目录

```
packages/dsh-bao/
  package.json           # dsh.bundle → cordis.patch.yml
  cordis.patch.yml       # 插件本体配置
  presets/bao.presets.yml# 两个 preset 的声明
  src/
    index.ts             # createBaoService：装配 + 重启恢复
    config.ts            # 插件配置与缺省值
    domain.ts            # 任务/项目/报告三张表的 zod schema
    store.ts             # domain 之上一层薄封装（事实，不是队列）
    host.ts              # 宿主能力边界 + 缺失时的可读提示
    host-types.ts        # 宿主 Agent 的最小结构类型
    orchestrator/
      gate.ts            # 并发闸门 + FIFO 队列
      runner.ts          # 派活、结算收尾、取消、关停
      tools.ts           # 三个工具
    test/
      m0.test.ts         # M0 验收测试
      tools.contract.test.ts # 用上游真实 defineTool 编译我们的定义
      helpers.ts         # 内存版 host 替身
```

## 3. 接线（在 dsh 里启用）

### 3.1 前置：宿主必须提供的三个能力

插件启动时会探测，缺哪个就在日志里说明缺哪个、以及怎么补（见 `src/host.ts`）：

| 能力 | 来源包 | 缺了会怎样 |
| --- | --- | --- |
| `ctx.subagents` | `@deepseek-ai/dsh-subagent` + 一个后端（如 `dsh-subagent-spawn-in-process`） | 无法派活 |
| `ctx.storageDomain` | `@deepseek-ai/dsh-storage-domain` + 一个 storage 后端 | **插件直接拒绝启动**，不会用内存假装持久化 |
| `ctx.tools` | `@deepseek-ai/dsh-tools` | 工具注册不上 |

### 3.2 安装插件

插件以本地目录形式安装到 dsh profile（M5 才做一键安装脚本）：

```bash
# 在仓库里先构建
pnpm --filter @opencoxswain/dsh-bao build

# 在你的 dsh profile 目录里指向这个包
#（profile 结构以你本机的 dsh 版本为准，M5 会固化成模板）
```

### 3.3 挂配置

把 `packages/dsh-bao/cordis.patch.yml` 的 `bao` 行合进 profile 的插件清单：

```yaml
- id: bao
  name: '@opencoxswain/dsh-bao'
  config:
    parentSessionId: '<你的全局助理会话 id>'   # 建议填上
    maxConcurrent: 5
    provider: spawn
    driverPreset: project-driver
    maxReportChars: 8000
```

**`parentSessionId` 说明**：派活时子代理挂在这个会话下，结算通知也回到这里。
- 填了：从别的会话派活会被**拒绝**并给出可读原因，保证汇报链路唯一。
- 留空：用调用方会话当父会话，能跑，但通知会回到那个会话——不是"全局汇总"的语义。

### 3.4 激活两个 preset

把 `packages/dsh-bao/presets/bao.presets.yml` 里的两行插入 profile，并确保：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: global-assistant   # 或你现有的默认 preset
```

- `global-assistant`：用户唯一入口，负责派活与汇总，自己不下场改代码。
- `project-driver`：在单个项目目录内执行，提示词里写死了"不能再派子助理"（`maxDepth` 默认 1）。

## 4. 用起来是什么样

```
用户：把登录页的重构推进一下，顺便看看昨天那个导出功能卡在哪了
```

全局助理的行为：

1. `dispatch_task({ projectPath: 'D:/work/webapp', title: '登录页重构', goal: '...' })` → `tsk_...`（立即返回）
2. `dispatch_task({ projectPath: 'D:/work/export-tool', title: '导出功能排障', goal: '...' })` → `tsk_...`
3. 立刻回复用户："已派 2 个项目：A 做登录页重构，B 查导出卡点。有结论我汇总给你。"

两个子代理**同时**跑起来（闸门 5 以内）。各自结束后：

- 子代理的收尾结论作为完成通知回到全局助理会话；
- 插件同时把结论写进 `report` 表，任务推进到 `done` / `failed`。

## 5. 设计上几个刻意的选择

| 选择 | 原因 |
| --- | --- |
| 槽位跟着 `activation.result` 释放，不跟着 `startActivation` 返回释放 | 子代理在后台跑，`startActivation` 早就返回了；那时就 release 等于闸门没设 |
| 派活失败 / 异常路径都 `gate.release` | 否则队列永久卡死 |
| 父 Agent 从工具 `exec.agent` 取，不做"插件级当前 Agent"缓存 | 并发工具调用会互相覆盖，会把 A 项目的任务挂到 B 会话下 |
| 重启后 `running` 一律改回 `queued` | 子代理随进程死了，`running` 是上一世的记忆 |
| 缺 `storageDomain` 时拒绝启动 | 不让"内存模式"假装持久化，避免用户以为任务存住了 |
| 工具定义用上游真实 `defineTool` 编译校验 | 我们的 schema DSL 写法必须被 dsh 自己的编译器接受 |

## 6. 已知缺口（进 M1 前的待办）

1. **重启后不会自动续跑**。目前只把 `running` 改回 `queued` 并记日志。续跑需要一个存活的父 Agent，而重启后没有；M1 应加一个显式的 `resume_task` 入口或新增会话选项。
2. **`brief` 字段目前为空**。简报在派活时实时渲染（`buildPrompt`），没有回写 `task.brief` 供审计。M1 补。
3. **没有看板**。现在只能靠 `list_tasks` 看状态，这是 M1 的活。
4. **宿主接线未在真实 dsh 上验证过**。本机安装的 dsh 正在使用中（asar 被占用），不能现场改。M0 的验证止于：11 条单元测试 + 用真实 `defineTool` 的编译校验 + 全仓 typecheck/build 通过。第一次真机接线时如果宿主签名与本文件的假设不符，按 `src/host.ts` 的提示改那一处即可。

## 7. 验证命令

```bash
pnpm --filter @opencoxswain/dsh-bao typecheck
pnpm --filter @opencoxswain/dsh-bao build
pnpm --filter @opencoxswain/dsh-bao test
```
