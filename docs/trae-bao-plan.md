# 对标「TRAE 宝」的 DeepSeek Harness 落地方案

> ⚠️ **本文已封存（2026-11-11）。当前权威方案是 [`self-developed-plan.md`](self-developed-plan.md)。**
>
> 封存原因：本文把"项目助理"实现为**一次性子代理**（`startActivation` 派活、结算即结束），
> 用户天然只与全局助理对话。这与修订后的**四层结构**冲突——项目助理 C 应当是**常驻于项目的根 Agent**，
> 用户直接与 C 对话，C 再派 D 执行。本文的 API 事实部分（第 2、8 节）仍然有效，可作为证据参考。

> 目标：在 DeepSeek Harness（下称 dsh）之上，做一个"一句话派活、多项目并行、成果统一汇总"的项目推进助理。
> 对标对象：字节 TRAE 于 2026-10-29 上线的「TRAE 宝」。
> 核实基线：本机已安装的 DeepSeek Harness **0.2.2-rc.1**（上游 `deepseek-ai/deepseek-harness`，MIT，Developer Preview）。本文所有引用 API 的段落都已按该版本的实际 README 与运行时代码核对，原文摘录见 [`dsh-api-findings.md`](dsh-api-findings.md)。
> 本文所有"能做"的结论都标注了证据级别，**不接受"理论上可以"**。
>
> **路线变更（2026-11-11）**：本项目原定"产品完全自研"（见 `prd/`、`plan.md`、`plugin-architecture.md` 等历史档案），现改为**先做 dsh 插件，再做完全体自研**。`apps/daemon` 与 `apps/desktop` 转为 legacy，不删、不再演进。

---

## 0. 怎么读这份文档

| 标记 | 含义 |
| --- | --- |
| ✅ | 已在 dsh 源码中确认存在该 API / 该行为，可直接用 |
| ⚠️ | 源码中确认有该 API，但**具体语义需要一次实测**才能写进承诺；本文给出实测方法和失败回退 |
| ❌ | dsh 不提供，且没有低成本绕过；方案里**明确不做**，不许诺 |

每条 ⚠️ 都必须先跑第 8 节的"上线前必测清单"，通过后才进入排期，否则走回退方案。

---

## 1. TRAE 宝到底做了什么（拆解）

### 1.1 产品结构：双层助理

| 层 | 职责 | 关键交互 |
| --- | --- | --- |
| **全局助理** | 跨项目记住历史任务、对话、产物；接收用户一句话，决定派给谁；汇总所有项目的进度、成果、待决策项 | 一个常驻入口；可以问到"上周那个 macOS 长截图工具做到哪了" |
| **项目助理** | 每个项目一个独立会话；拆解任务、执行、自己再调度子任务并行；向全局助理汇报 | 用户通常不直接进项目会话，只看汇总 |

这两层的本质是：**一个编排者 + N 个有独立工作目录的执行者**，编排者对执行者只有"派活 / 收报告"两种动作，不共享上下文。

### 1.2 六个可被复刻的能力点

1. **跨项目记忆**：做过的事不用反复讲。
2. **多任务同时推进**：实测最多 5 个项目并行不串台。
3. **进度与成果统一汇总**：所有项目的产出、卡点、待决策项回到同一个助理。
4. **记忆白盒**：记忆是本地 Markdown 文件（用户级原则 / 项目规则 / 每日聊天日志），用户可读可改。
5. **IM 绑定**：绑定飞书/微信后，离开电脑也能提需求、问进度。
6. **执行在本地**：任务依赖本机电脑，不是云端跑。

### 1.3 它没做的（也是我们的边界参考）

- 不做视频生成。
- 不做云端沙箱执行，任务必须落在本机。
- 记忆不做向量检索，靠 Markdown 文件 + 人工/模型提炼；长期会冗余冲突，需要专门的"提炼"动作。

---

## 2. dsh 逐项能力核对

### 2.1 总表

| # | 能力点 | dsh 现状 | 结论 |
| --- | --- | --- | --- |
| 1 | 全局 / 项目双层会话 | 会话带 `SessionHeader.cwd`，可按目录归属；宿主有可选的 `ctx.workspaceRegistry` | ✅ 可行 |
| 2 | 派活给一个"项目助理" | `ctx.subagents.startActivation({ provider, label, request, signal, delivery })`，`request` 内支持 `cwd` / `agentPreset` / `prompt`，结构化输出按每次 activation 单独挂载 | ✅ 可行（并发配额见 2.3） |
| 3 | 多项目并行 | `maxActiveSubagents` 默认 8 / 每棵树；`maxDepth` 默认 1；超出**直接拒绝、不排队**（上游明确设计） | ✅ 可行，但**必须自建队列** |
| 4 | 跨项目记忆 | 无 memory / embedding / RAG 包；有 `ctx.storageDomain`（schema 校验的 KV 域，读同步、写落盘后 resolve）与 `ctx.sessionQuery`（SQLite FTS 词法检索） | ⚠️ 可行，需自研一层 |
| 5 | 记忆注入模型上下文 | `ctx.systemPrompt.section({ name, order, text \| render })`；外部 section 可用任意有限 order，scope 内可覆盖全局 | ✅ 可行 |
| 6 | 后台/定时推进 | `ctx.schedule.create({ title, prompt, timing, target })`，7 种 timing，持久化、重启保留 | ✅ 可行（⚠️ desktop 默认不启用） |
| 7 | 无人值守审批 | `ApprovalPolicy = 'ask' \| 'never'`，**`never` 是确定性拒绝，不是放行**；`SandboxMode = read-only \| workspace-write \| danger-full-access` | ⚠️ 可行，但要选对 preset |
| 8 | IM 接入 | 无 telegram / feishu / lark / wecom / dingtalk / slack 通道插件（全仓 0 命中）；有 `ctx.webServer.register` + `ctx.webhookRuntime`（仅 GitHub adapter，不存状态、不去重） | ⚠️ 可行，需自研网关 |
| 9 | 看板 / 面板 UI | `ctx.slots.register/inject`、`ctx.sidebarRightTabs.register`、`dsh.client` 客户端入口 | ✅ 可行 |
| 10 | 崩溃后不丢任务 | `ctx.jobs` 是**进程本地内存态**，重启即失；domain 持久化不跨进程共享 | ⚠️ 需把状态写进 domain 表，不依赖 jobs |
| 11 | 后台进程长跑 | 子代理强绑父树（`waitForTreeWork` / `drainDescendants` / `dispose`） | ❌ 不能脱离父树独立长跑 |
| 12 | 容器级隔离 | 无容器沙箱；Windows 上 ACL 受限令牌是"部分强制执行" | ❌ 不支持 |
| 13 | 拦截工具调用 | `ctx.tools.guard()` **只能拒绝**，不能改写参数、不能放行被策略拒绝的调用；`ctx.tools.restrict()` 才能把工具从模型可见集移除 | ✅ 够用（只做 deny 白/黑名单，见 7.5） |
| 14 | 会话元数据扩展 | `SessionHeader` 字段固定，不可扩展 | ❌ 不要往 header 塞业务字段 |

### 2.2 关键 API（形态已按 0.2.2-rc.1 实测修正，可直接照抄）

```ts
// 工具注册
ctx.tools.register(defineTool({
  name: 'dispatch_task',
  description: '把一件工作派给某个项目的项目助理',
  parameters: { /* JSON Schema */ },
  output: { schema: { /* JSON Schema */ }, render: (value) => String(value) },
  async execute(args, exec) { /* ... */ },
}));

// 工具流水线（guard 只能拒绝，且不可被后续监听器翻案）
ctx.tools.guard((call) => call.name === 'bash' ? { kind: 'deny', reason: '无人值守模式禁用' } : { kind: 'allow' });
// 需要"连 schema 一起从模型可见集移除"时用 restrict，省 token
ctx.tools.restrict((tool) => tool.name !== 'bash');

// 持久化（zod schema 校验；读同步自内存，写落盘后才 resolve）
const baoSpec = defineDomain({
  name: 'bao', version: 1,
  tables: { task: domainTable(TaskRowSchema) },
});
const bao = await ctx.storageDomain.open(baoSpec);
await bao.table('task').put(taskId, row);
bao.table('task').update(taskId, (r) => ({ ...r, status: 'running' }));
bao.table('task').get(taskId);          // 同步
ctx.effect(() => { void bao.close(); }); // 卸载时释放
// domain/changed 是进程内通知，不跨窗口/跨进程

// 系统提示注入
ctx.systemPrompt.section({
  name: 'bao.memory',
  order: 60,
  render: async () => `以下是本项目既定规则：\n${rulesText}`,
});

// 派活：cwd / agentPreset 在 request 里；返回 { childId, result, dispose }
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',
  label: task.title,
  request: {
    parent: globalSessionId,     // 见下方说明：父会话由调用上下文确定
    cwd: projectRoot,
    agentPreset: 'project-driver',
    prompt: taskBrief,
    agentOptions: { /* 模型/推理强度等子代理设置 */ },
    // 结构化输出按每次 activation 单独挂载，不是顶层字段
  },
  delivery: 'parent',            // 'parent' = 结算后向父会话投递一条完成通知；'caller' = 不投递，由调用方 await
});
const { childId, result, dispose } = activation;
// result: 子代理结束（含后代清理与通知）后才 settle
// dispose(): 取消这次 activation 并等待其整棵后代收敛

// 网页路由（IM 回调）
ctx.webServer.register({
  kind: 'prefix',
  path: '/bao/im/feishu',
  handler: async (req) => { /* 验签、去重、入队 */ },
});

// 客户端面板
ctx.slots.register(
  { name: 'sidebar.panellist', id: PANEL_ID, order: 900, label: '推进看板' },
  TaskboardPanel,
);
ctx.layout.selectPanel(PANEL_ID);
```

> ⚠️ **父会话必须由插件持有**，不能让工具调用自行决定"父是谁"。工具是被某个会话的模型调用的，但设计上应是"全局助理派活"，两者重合时才对得上。M0 通过插件配置项 `parentSessionId` 绑定全局助理会话；派活时校验调用方会话与之相同，否则拒绝。详见 9.0。

### 2.3 并发配额的真实边界

- `maxActiveSubagents` 默认 **8 / 每棵树**，超限**直接拒绝**，错误码 `ACTIVATION_LIMIT_REACHED`。上游 README 明确写"admission does not queue"：等待后代的父代理不能去等自己被占用的槽位。所以**排队必须由我们做**。
- 对应 TRAE 宝"最多 5 个项目不串台"，我们设闸门 **5**，第 6 个进队列。
- `maxDepth` 默认 1：项目助理**不能再派子助理**。所以"项目内再拆并行子任务"必须由项目助理自己用 dsh 的普通并行工具做，而不是再套一层 `startActivation`。这一点必须在 preset 的系统提示里写死，否则模型会尝试嵌套并失败。
- `agentPreset` 只有 `spawn` 支持，`fork` 与外部执行体会直接拒绝该选项。
- 槽位是**进程本地**的，不约束历史会话累计量；重启后计数从零开始。

### 2.4 明确不支持，方案里不做

| 不做的事 | 原因 |
| --- | --- |
| 容器 / 虚拟机隔离 | dsh 只有文件系统沙箱档位，没有容器；Windows 上还是部分执行 |
| 关掉电脑后任务继续跑 | 进程在本地，关掉即停。TRAE 宝同样如此，这是产品共识，不是缺陷 |
| 子代理脱离父会话独立存活 | 生命周期强绑树根 |
| 往 `SessionHeader` 加业务字段 | 字段固定，不可扩展 |
| 依赖 `ctx.jobs` 记任务状态 | 进程内存，重启即失 |
| 依赖 `domain/changed` 跨窗口同步 | 仅进程内事件 |

---

## 3. 整体架构

```
┌──────────────── 用户 ────────────────┐
│  桌面 UI（dsh 官方 Electron 壳）       │
│  或 飞书 / 微信                       │
└───────────────┬──────────────────────┘
                │ 一句话
┌───────────────▼──────────────────────┐
│  全局助理（global session）           │
│  cwd = ~/.dsh/bao（稳定目录）         │
│  工具：dispatch_task / list_tasks /   │
│        report_back / remember / recall│
│  注入：用户级原则 + 项目索引          │
└───┬───────────────┬──────────────────┘
    │ 派活（队列 5 并发）                │
┌───▼───────┐  ┌────▼──────┐  ┌────▼──────┐
│ 项目助理 A │  │ 项目助理 B │  │ 项目助理 C │
│ cwd=A      │  │ cwd=B      │  │ cwd=C      │
│ preset=    │  │ preset=    │  │ preset=    │
│ project-   │  │ project-   │  │ project-   │
│ driver     │  │ driver     │  │ driver     │
└───┬───────┘  └────┬──────┘  └────┬───────┘
    │ 报告（delivery 回投父会话）     │
    └───────────────┴───────────────┘
                │
┌───────────────▼──────────────────────┐
│  dsh-bao 插件（宿主）                 │
│  · domain 表：project/task/memory/... │
│  · 并发闸门 + 队列                    │
│  · 记忆文件读写与提炼                  │
│  · IM 网关（webServer + 验签 + 去重）  │
│  · 审计（每次工具调用落表）            │
└───────────────┬──────────────────────┘
                │
        ~/.dsh/bao/**           <project>/.opencoxswain/**
        （记忆白盒 Markdown）    （项目规则 / 每日日志）
```

**为什么不用现在的 daemon**：daemon + 任务树 + 审批 + worktree + 合并，等于自己重造了 dsh 已经提供的会话、工具、沙箱、审批、调度、UI 插槽。新的做法是**只写一层薄业务插件**，底盘全部交给 dsh。旧 daemon 先降级为 legacy，不删、不再演进。

---

## 4. 插件清单（自研范围）

一个 monorepo 包 `packages/dsh-bao`，内部按模块划分，对外只暴露一个 bundle。

| # | 模块 | 职责 | 能否省 |
| --- | --- | --- | --- |
| 1 | `orchestrator` | `dispatch_task` / `list_tasks` / `cancel_task` 工具；并发闸门与队列；子会话生命周期 | 不能 |
| 2 | `report` | 子代理完成回投、`report_back` 工具、报告落表 | 不能 |
| 3 | `memory` | 白盒 Markdown 读写、检索、`systemPrompt.section` 注入、`remember` / `recall` 工具 | 不能 |
| 4 | `unattended` | 无人值守策略：强制权限档位、工具黑名单、全量审计 | 不能（要"离开电脑"就必须有） |
| 5 | `im-gateway` | 飞书 webhook 验签 + 事件去重 + 出站推送 + 卡片按钮 | M4 才做 |
| 6 | `taskboard`（client） | 看板面板：项目卡片、任务列表、卡点、待决策 | M1 就要，但可先用 CLI 顶 |
| 7 | `presets` | `global-assistant` / `project-driver` 两个 agent preset | 不能 |
| 8 | `distribution` | profile 模板、`cordis.patch.yml`、安装脚本 | 不能 |

### 4.1 目录结构

```
packages/dsh-bao/
  package.json            # dsh.bundle + dsh.client + peerDeps
  cordis.patch.yml
  tsconfig.json
  src/
    index.ts              # 注册服务 bao，装配各模块；接线失败给可读原因
    config.ts             # 插件配置（parentSessionId / 并发上限 / preset 名）
    host.ts               # 宿主 API 的结构化类型声明 + 运行时能力探测
    domain.ts             # 表定义 + zod schema
    orchestrator/
      gate.ts             # 并发闸门（5）+ FIFO 队列
      runner.ts           # startActivation 封装、结算收尾、异常兜底
      recover.ts          # 重启恢复 running → queued
      tools.ts            # dispatch_task / list_tasks / cancel_task
    report/
      collector.ts        # 结算回投、报告解析、落 report 表
    presets/
      global.ts           # global-assistant preset 定义
      driver.ts           # project-driver preset 定义
    client/
      index.ts            # dsh.client 入口（M1）
      Taskboard.tsx       # （M1）
```

M0 只落 `index / config / host / domain / orchestrator / report / presets` 这几块；`memory/`、`unattended/`、`im/`、`client/` 按 M2–M4 陆续补齐，不在 M0 留空壳。

### 4.2 `package.json` 关键字段

```json
{
  "name": "@opencoxswain/dsh-bao",
  "type": "module",
  "main": "dist/index.js",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "entry": "dist/client/index.js",
      "inject": ["slots", "layout", "sidebarRightTabs"],
      "immediately": false,
      "external": true
    }
  }
}
```

> `dsh.client` 的字段名以 dsh 当前 `dsh.client` 定义为唯一来源；`entry` 若在实测中不叫这个名字，按 `apps/desktop` 与 `packages/client/ui-plugin-manager` 里的实际写法改。这条列在必测清单第 5 项。

---

## 5. 数据模型

### 5.1 domain 表（持久化，跨重启）

> 形态修正：dsh 的 domain 是 `defineDomain({ name, version, tables: { t: domainTable(zodSchema) } })` + `ctx.storageDomain.open(spec)`，**schema 用 zod 声明**，不需要手写迁移函数。读是同步内存读，写落盘后才 resolve。

```ts
interface ProjectRow {
  id: string;            // 'prj_' + nanoid
  name: string;
  rootPath: string;      // realpath 归一化后的小写
  createdAt: string;
  updatedAt: string;
  archived: 0 | 1;
}

interface TaskRow {
  id: string;
  projectId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  status: 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
  priority: number;
  sessionId: string | null;   // 项目助理子会话 id（childId）
  brief: string;              // 下发给项目助理的完整任务简报
  summary: string | null;     // 项目助理回报的结论
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

interface ReportRow {
  id: string;
  taskId: string;
  sessionId: string;
  kind: 'progress' | 'blocked' | 'done' | 'failed';
  body: string;
  needsUser: 0 | 1;   // 是否待用户决策
  createdAt: string;
  ackedAt: string | null;
}

interface MemoryRow {
  id: string;
  scope: 'user' | 'project';
  projectId: string | null;
  kind: 'principle' | 'rule' | 'journal' | 'fact';
  path: string;        // 相对 ~/.dsh/bao 或 <project>/.opencoxswain
  text: string;        // 便于检索的正文副本
  hash: string;
  updatedAt: string;
}

interface AuditRow {
  id: string;
  sessionId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  reason: string | null;
  argsDigest: string;
  createdAt: string;
}
```

> 为什么把任务状态放 domain 而不是 `ctx.jobs`：jobs 是进程内存，重启即失；domain 才是持久的。jobs 只用来跑"本轮进程内的一次动作"。

### 5.2 记忆白盒文件（对齐 TRAE 宝）

```
~/.dsh/bao/
  user/
    principles.md          # 用户级原则（语气、偏好、禁忌）
  index/
    memory.jsonl           # 检索索引副本（可重建，不是真相）

<project>/.opencoxswain/
  rules.md                 # 项目规则（技术栈、提交规范、不可动目录）
  journal/
    2026-11-11.md          # 当日聊天与决策日志
  reports/
    2026-11-11-tsk_xxx.md  # 任务报告归档
```

规则：
- **文件是真相，domain 只是索引**。索引丢了可以扫目录重建。
- 写入一律"先写临时文件再 rename"，避免半截文件。
- 用户手改文件后，下一次 `recall` 通过 hash 比对发现变化并重建索引。
- 每日日志只追加；`distill` 动作把高频结论提炼进 `principles.md` / `rules.md`，并在原日志里标记 `<!-- distilled -->`。

---

## 6. 端到端时序

### 6.1 一句话派活

```
用户: "把登录页的重构推进一下，顺便看看昨天那个导出功能卡在哪了"
  │
  ▼
全局助理（session G）
  ├─ recall("登录页 重构") → 命中项目 A 的 rules.md + 上次任务 tsk_01
  ├─ recall("导出")       → 命中项目 B 的 journal，发现 blocked
  ├─ dispatch_task({projectPath: A, title:"登录页重构", goal:"..."}) → tsk_11 (queued)
  └─ dispatch_task({projectPath: B, title:"导出功能排障", goal:"..."}) → tsk_12 (queued)
  │
  ▼ 闸门（当前 running=2，上限 5，直接放行）
startActivation({ provider:'spawn', parent:G, cwd:A, agentPreset:'project-driver', prompt:brief })
startActivation({ provider:'spawn', parent:G, cwd:B, agentPreset:'project-driver', prompt:brief })
  │
  ▼
全局助理立刻回复用户："已派 2 个项目：A 做登录页重构，B 查导出卡点。有结论我汇总给你。"
```

关键：`dispatch_task` **不阻塞**，立即返回 `taskId`。阻塞就等于放弃并行。

### 6.2 项目助理执行

```
项目助理（session A，cwd=A，preset=project-driver）
  ├─ 系统提示注入：A 的 rules.md + 该项目最近 3 条报告
  ├─ 读代码 / 改代码 / 跑测试（dsh 自带工具）
  ├─ 中途 report_back({kind:'progress'|'blocked', body}) → 落表，必要时回投 G
  └─ 结束：输出结构化结论（按 activation 级 outputSchema）
```

### 6.3 汇总回传（语义已按上游 README 确认）

```
子代理结束（含后代清理与结算通知）
  │
  ├─① delivery:'parent' 向父会话 G 追加一条 user-role 状态通知：子代理最后的非空文本块
  └─② 插件在 result 结算后写 ReportRow(kind:'done')、TaskRow.status='done'
  │
  ▼
G 收到通知 → 汇总："A 登录页重构完成，改了 6 个文件，测试全绿；B 的导出卡在权限接口，需要你确认用哪种鉴权。"
```

已确认的细节（原文见 `dsh-api-findings.md` 的 subagent README「Settlement notice」段）：

| 问题 | 实测结论 |
| --- | --- |
| 是否唤醒父会话 | **会**。通知到达**空闲**的 G 会起一轮独立模型请求；G 正忙时**不额外重发**，只追加进历史，G 当前这轮结束后自然看到 |
| 通知内容 | 子代理最后的非空文本块；`Structured result: <JSON>` 单独一块；推理块与其他非文本块被剔除 |
| 空收尾 | 显示 `It left no closing message.` |
| **会丢信息的一处** | 子代理结束前最后一个动作恰好是 `send_message` 给父会话时，收尾文本**被省略**，换成 `It sent you a message just before finishing, so its closing message is omitted.`；要拿回被省略的收尾文本只能再给子代理发消息 |
| 成本 | 每次结算一条通知；父会话忙时不产生额外请求 |

因此**不需要**回退方案里的 `session.prompt` 主动注入。但汇总链路必须防"收尾文本被省略"：项目助理 preset 要求**先输出结论、再发消息**，不要拿 `send_message` 当收尾动作。报告正文以插件侧 `ReportRow` 为准（`result` 里的完整输出与结构化值），不依赖父会话收到的通知文本。

### 6.4 离开电脑：IM 问进度

```
飞书 → POST /bao/im/feishu
  ├─ 验签（timestamp + nonce + body 签名）
  ├─ event_id 去重（domain 表 im_event）
  ├─ 文本 → 找到/创建 G（若 G 不在，新建一个并恢复上下文摘要）
  ├─ session.prompt(G, "用户从飞书问：导出功能怎么样了？")
  └─ G 回复 → 出站 API 推回飞书（文本 + 卡片按钮：继续 / 暂停 / 看详情）
```

约束：**必须有一个 dsh 进程在跑**（`dsh web` 或桌面壳常驻托盘）。电脑关机就停，这一点和 TRAE 宝一致。

### 6.5 无人值守（夜间推进）

```
ctx.schedule.create({
  title: '夜间推进',
  prompt: '检查所有 running 任务的进展，失败的尝试修复一次，然后汇总',
  timing: { kind: 'daily', at: '02:00' },
  target: { kind: 'session', sessionId: G },
})
```

- 权限档位用 `danger-full-access`（sandbox=full-access + approval=never）。`never` 表示"没人可问 → 直接拒绝"，不是自动放行；真正让它跑起来的是 full-access 沙箱。
- `unattended` 插件在此时段启用 guard 黑名单：禁 `git push`、禁读取密钥、禁写项目外目录。
- 所有工具调用写 `AuditRow`，第二天在面板上能逐条看。

---

## 7. 关键实现要点

### 7.1 并发闸门（必须自写）

```ts
// orchestrator/gate.ts —— 闸门只做"准入"，不做生命周期
const LIMIT = 5;

export class Gate {
  private running = new Set<string>();
  private queue: Array<{ id: string; resume: () => void }> = [];

  async acquire(taskId: string): Promise<void> {
    if (this.running.size < LIMIT) {
      this.running.add(taskId);
      return;
    }
    await new Promise<void>((resume) => { this.queue.push({ id: taskId, resume }); });
    this.running.add(taskId);
  }

  release(taskId: string): void {
    if (!this.running.delete(taskId)) return;
    const next = this.queue.shift();
    next?.resume();
  }

  stats() { return { running: this.running.size, queued: this.queue.length, limit: LIMIT }; }
}
```

两条约束：

1. **闸门只在内存里有效**，重启即清零。任务状态以 domain 表为准，重启后按 `status` 重新入队（见 7.2）。
2. **`running` 里必须放"已真正占住 dsh 槽位"的任务**，所以 `acquire` 要在 `startActivation` 成功返回**之后**才算占位成功；`startActivation` 抛错时立刻 `release`，否则会漏掉一个永久槽位。

> 为什么不用 `maxActiveSubagents` 自己排队：它超限**直接拒绝**，没有排队语义。我们必须自己排队，否则第 6 个项目直接报错。

### 7.2 派活工具

```ts
async execute(args, exec) {
  const project = await ensureProject(args.projectPath);      // upsert domain
  const task = await createTask({ ...args, projectId: project.id, status: 'queued' });

  void runTask(task.id);                                       // 不 await，立即返回
  return { taskId: task.id, project: project.name, status: 'queued' };
}

async function runTask(taskId: string) {
  await gate.acquire(taskId);          // 排队期间任务状态保持 queued
  let activation;
  try {
    await update(taskId, { status: 'running' });
    activation = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: task.title,
      request: {
        parent: parentSessionId,
        cwd: project.rootPath,
        agentPreset: 'project-driver',
        prompt: buildBrief(task, project),
      },
      delivery: 'parent',
    });
    await update(taskId, { sessionId: activation.childId });
  } catch (error) {
    // 两件事都要做：落失败状态 + 还槽位，否则队列永久卡死
    await update(taskId, { status: 'failed', blockedReason: String(error) });
    gate.release(taskId);
    return;
  }

  // 结算后才释放：result 在子代理（含后代）收敛后才 settle
  void activation.result.then(
    async (result) => { await finishTask(taskId, result); gate.release(taskId); },
    async (error) => { await failTask(taskId, error); gate.release(taskId); },
  );
}

// 进程启动时：把上次残留的 running 改回 queued 重新入队
async function recoverOnStart() {
  for (const task of await listTasks({ status: 'running' })) {
    await update(task.id, { status: 'queued', blockedReason: null });
    void runTask(task.id);
  }
}
```

要点：**槽位跟着 `result` 结算走，不跟着 `startActivation` 返回走**。子代理在后台跑，`startActivation` 早就返回了；如果那时就 release，闸门等于没设。

### 7.3 记忆注入（每次会话开头的固定段落）

```ts
ctx.systemPrompt.section({
  name: 'bao.memory',
  order: 60,
  render: async (context) => {
    const root = context.session?.header?.cwd;
    const rules = root ? await readIfExists(path.join(root, '.opencoxswain', 'rules.md')) : '';
    const principles = await readIfExists(path.join(HOME, 'user', 'principles.md'));
    return [principles && `## 用户原则\n${principles}`, rules && `## 项目规则\n${rules}`]
      .filter(Boolean).join('\n\n');
  },
});
```

要点：**只注入规则，不注入全部历史**。历史靠 `recall` 按需取，否则上下文必爆。

### 7.4 记忆检索

dsh 的 `ctx.sessionQuery` 是 SQLite FTS 词法检索，**不是向量检索**。我们也用词法，匹配方式：

1. 关键词切分（中文按 2-gram）。
2. 对 `MemoryRow.text` 做包含 + 位置打分。
3. 命中条数上限 20，按"项目内 > 全局"排序。

不引入 embedding，理由：TRAE 宝也是白盒文件 + 文本，向量带来的复杂度（模型、维度、重排）与收益不成比例，且 dsh 没有现成的向量存储。

### 7.5 无人值守策略

```ts
// 1) 从模型可见工具集移除高危工具：连 schema 一起省掉 token
const restricted = ctx.tools.restrict((tool) => !TOOL_BLOCKLIST.includes(tool.name));
// 离开无人值守时段时释放：restricted() 会被调用
restricted();

// 2) 参数级下限：guard 在 pre-execute waterfall 之后、且只能拒绝
const BLOCKED = ['git push', 'git reset --hard', 'rm -rf', 'secrets.read'];

ctx.tools.guard((call) => {
  if (!policy.armed) return { kind: 'allow' };
  if (BLOCKED.some((p) => JSON.stringify(call.args).includes(p))) {
    return { kind: 'deny', reason: '无人值守模式禁止该操作' };
  }
  return { kind: 'allow' };
});
```

注意三点（均已按上游 README 确认）：

1. **guard 只能拒绝，不能改写参数、不能放行**。所以"允许一部分"只能靠"默认允许 + 黑名单拒绝"。
2. **guard 排在 `tools/pre-execute` waterfall 之后**，任何一个 pre-execute 监听器放行的调用，仍会被 guard 拦下；反之 guard 拒绝的调用，后续监听器**无法**翻案。这正是我们想要的单调下限。
3. **要真正省 token / 降低模型试探，用 `restrict` 把工具从可见集移除**，guard 只是兜底。两者配合：`restrict` 管"模型根本看不见"，`guard` 管"看得见也调不动"。

### 7.6 面板 UI

- 全局面板挂在 root 作用域的 keyed `main` slot，并在 `sidebar.panellist` 注册入口。
- 面板内容：项目分组 → 任务卡片（状态、耗时、最近一条报告）→ 待决策区。
- 选中态是 transient 的，需要在 localStorage 里恢复（dsh 自带面板也是这么做的，参考 `packages/client/ui-plugin-manager/src/client/index.ts`）。
- 数据来源：插件暴露 `bao/status` 查询（域名表读取），客户端轮询或 SSE。**不要依赖 `domain/changed` 跨窗口推送**，它只在进程内。

---

## 8. 上线前必测清单

原清单 5 项中，第 3、4 项已由上游 0.2.2-rc.1 README 直接回答，**降级为"已确认、代码里落实即可"**；剩下 3 项仍需真机实测。台账：

| # | 要验证的事 | 状态 | 结论 / 方法 | 不通过的回退 |
| --- | --- | --- | --- | --- |
| 3 | 空白会话是否复用 | ✅ 已确认 | 不复用：`spawn` 每次给一个**全新空会话**，任务 prompt 必须自足。本地子代理会话可后续 `sendMessage` 续聊、可冷恢复；外部执行体只跑一次。 | 不适用 |
| 4 | `delivery` 是否唤醒父会话 | ✅ 已确认 | `delivery:'parent'` 在**父会话空闲时**起一轮独立请求；父会话忙时只追加历史不重发。另注意收尾文本可能被省略（见 6.3），报告正文以插件侧记录为准。 | 不适用 |
| 1 | desktop 是否默认不启用定时任务；schedule 能否唤醒"冷"的旧会话 | ⚠️ 待实测 | 在 desktop profile 下建 `every 1m` 任务，target 指向一个已关闭的会话，观察是否触发 | 改用 `target: {kind:'new'}` 每次新建会话；或把 Web 模式作为常驻服务 |
| 2 | Windows 上 `danger-full-access` 的真实边界（能写哪些目录、能否绕过 ACL） | ⚠️ 待实测 | 在非项目目录写文件、读 `%USERPROFILE%\.ssh`，记录实际结果 | 收敛到 `workspace-write` + 逐项目 `--add-dir`，放弃"无人值守全自动" |
| 5 | `dsh.client` 的入口字段与多窗口下面板选中一致性 | ⚠️ 待实测 | **本机 asar 已剥掉所有 `.d.ts`**，字段只能以运行时/`dsh.client` 实际定义为准；同一 profile 开两个窗口，切面板、刷新 | 面板状态全部放 localStorage + 后端轮询，不依赖内存态 |

> M0 不依赖第 1、2、5 项中的任何一项结论，所以可以先做；第 1 项在 M3（定时）前必须跑完，第 5 项在 M1（看板）前必须跑完。

---

## 9. 分阶段落地（按当前实际进度重排）

### 9.0 M0 的前置约束（落地时才发现的三条）

写在最前面，因为它们决定 M0 的形态：

1. **类型缺失**：本机安装的 dsh 在 asar 中**不含任何 `.d.ts`**。插件不能靠 `import type { ... } from '@deepseek-ai/dsh-*'` 拿类型，只能写最小化的**结构化类型声明**（只声明我们用到的几个字段），并在运行时做防御性校验。
2. **宿主 API 面未验证**：`ctx.subagents` / `ctx.storageDomain` / `ctx.tools` 等是否在插件上下文里可见、`defineTool` 的准确签名，都需要一次真机接线验证。M0 的交付物必须能"接线失败给可读原因"，而不是静默不工作。
3. **任务状态与槽位解耦**：domain 表是持久化真相，闸门是进程内准入；重启后按 `status='running'` 恢复为 `queued` 重新入队。不能把二者混为一谈。

### M0：能派活、能回传（最小闭环）

交付：
- `packages/dsh-bao` 骨架 + `cordis.patch.yml` + profile 模板。
- 两个 preset：`global-assistant`、`project-driver`。
- 三个工具：`dispatch_task`、`list_tasks`、`cancel_task`。
- 并发闸门 5 + FIFO 队列 + domain 表 `project` / `task` / `report`。
- 重启恢复：`running` → `queued` 重新入队。
- 事件订阅：`subagent/catalog` / 子代理结算 → 落 `report` 表。

M0 明确**不做**：记忆、看板、定时、IM。它们各自的 ⚠️ 未实测项不要提前耦合进来。

验收：
- 说"给 A 项目和 B 项目各派一件事"，两个项目助理同时起，互不串台。
- 关掉 dsh 重启后 `list_tasks` 仍能看到这两个任务，且自动续跑。
- 第 6 个任务进队列，`list_tasks` 显示 `queued`，前一个结束后自动开始。
- 子代理结束后，`report` 表有该任务的 `done` 记录与结论摘要。

### M1：看板

交付：`taskboard` 客户端面板 + `bao/status` 查询接口。

验收：面板能看到项目分组、任务状态、最近报告；点任务能看到完整 brief 与报告；刷新后选中态保持。

### M2：记忆

交付：`memory` 模块（文件读写、索引、`remember` / `recall`、`systemPrompt.section` 注入）、`distill` 命令。

验收：
- 新会话问"这个项目我们约定过什么"，能答出 `rules.md` 内容。
- 手动改 `rules.md`，下一次会话立即生效。
- 每日日志连续 7 天后跑 `distill`，产出精简后的 `rules.md`，原日志保留。

### M3：定时推进

交付：schedule 集成 + `unattended` 策略 + 审计表 + 面板审计视图。

验收：设定每日 02:00 推进，第二天能看到完整审计记录；被黑名单拦截的操作可见且未执行。

### M4：IM（飞书优先）

交付：`im-gateway`（路由、验签、事件去重、出站文本/卡片）、卡片按钮回调（继续/暂停/详情）。

验收：从飞书发"进度怎么样"，30 秒内收到汇总；同一条事件重复投递只处理一次；点"暂停"能真的停掉对应任务。

### M5：打包分发

交付：一键安装脚本（写 profile、装 bundle、建 `~/.dsh/bao` 目录）、首次启动引导（选模型、选权限档位、绑 IM）。

验收：干净机器上跑一条命令，`dsh web` 打开即有"推进看板"面板和可用的全局助理。

---

## 10. 与 TRAE 宝的差距（如实说）

| 维度 | TRAE 宝 | 本方案 | 差距性质 |
| --- | --- | --- | --- |
| 双层助理 | 产品内建 | 一个 preset + 一个编排插件 | 对齐 |
| 跨项目记忆 | Markdown 白盒 | 同样 Markdown 白盒 + 索引 | 对齐 |
| 并行项目数 | 5 | 闸门 5，dsh 配额 8 | 对齐 |
| 统一汇总 | 内建 | 回投 + 报告表 + 看板 | 对齐（回投语义待测） |
| IM | 飞书/微信官方绑定 | 自研飞书网关；微信需公众号/企微，工作量另算 | 部分 |
| 执行环境 | 本地 | 本地 | 对齐 |
| 隔离强度 | 未知（闭源） | 仅文件系统沙箱，无容器 | **弱于可能存在的容器方案** |
| 关电脑继续 | 不支持 | 不支持 | 对齐 |
| 多模型 | 字节系 | dsh 支持任意模型 | **强于** |

---

## 11. 不做清单（写进 README，避免误导用户）

1. 不做容器/虚拟机沙箱。
2. 不做"关机后任务继续跑"。
3. 不做子代理脱离父会话独立长跑。
4. 不做向量记忆 / RAG（词法够用，且 dsh 无向量存储）。
5. 不把业务字段塞进 `SessionHeader`。
6. 不用 `ctx.jobs` 当任务状态源。
7. 不承诺 `approval=never` 能自动放行（它是拒绝）。
8. 不在无人值守时开放 `git push`。

---

## 12. 下一步

1. 先做必测清单第 1、4 项（决定 M0 的形态），半天内能出结论。
2. 必测通过后开工 M0，只做"派活 + 回传 + 持久化"三件事。
3. 旧 `apps/daemon` 与 `apps/desktop` 标记为 legacy，不再新增功能，等 M5 完成后再决定是否移除。
