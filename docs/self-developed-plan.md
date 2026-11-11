# OpenCoxswain 自研方案：用户 / 全局助理 / 项目助理 / 执行 Agent

> 版本：2026-11-11 v1（2026-11-11 晚补注实现状态）
> 状态：**自研路线重启**。本文的四角色定义与流程设计仍然有效；
> 但实现已从"dsh 插件"改为"自研运行时"（用户明确要求产品不依赖 dsh）。
> **实现状态以 [`roadmap.md`](roadmap.md) 为准**，本文头部与各阶段已标注完成情况。
> 证据基线：DeepSeek Harness `0.2.2-rc.1` 的公开类型定义（`@deepseek-ai/dsh-agent` / `dsh-subagent` / `dsh-session` / `dsh-tools` / `dsh-storage-domain`）。
> 本文每个"能"的结论都标注了实际依据；不写"理论上可以"。

---

## 实现状态速览（2026-11-11 晚）

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| **P0** 四个关键假设 | ✅ **全部成立** | 见 [`verify/p0-findings.md`](verify/p0-findings.md)。基于 dsh 类型定义验证，但行为事实对自研同样适用 |
| **P1** 主推流程可用 | ✅ **已完成** | C 常驻、D 派发、并行、写域互斥、先完成先报，见 `apps/runtime` |
| **P2** B 全局助理 | ✅ **已完成** | 路由带依据、转交原话、依据不足时反问 |
| **P3** 用户直连 D | ✅ **已完成** | D 可续聊（带原上下文），C 知情（落汇报） |
| **P4** 主动推进 | 🟡 **部分** | 卡点三分类已做；自动换法重试由 C 决策（非硬编码），去抖已做 |
| **P5** 记忆与白盒 | 🟡 **部分** | 记忆层已完成（含写入门槛）；**自动提炼未做** |
| **P6** 看板与 IM | 🟡 **部分** | 界面已完成（左侧导航 + 轨迹视图）；**IM 通道未做** |

**与本文最重要的偏差**：C 不再是 dsh 的根 Agent，而是自研运行时里的常驻会话；
D 不再是 dsh 子代理，而是自研的独立 Agent 循环。**设计原则不变，实现载体全换。**

---

## 0. 先回答"偏差在哪"

你说得对，前几版跑偏了。偏差不是执行细节，是**产品形态**：

| 前一版做成了什么 | 你要的是什么 |
| --- | --- |
| 「用户 → 全局助理 → **项目助理子代理** → 完事」两层 | 「用户 → B 全局助理 → **C 常驻项目助理** → **D 执行 Agent**」三层 |
| C 被当成"一次派活就结束的子代理" | C 是**长期属于项目**的存在，可反复对话、可连发、可主动推进 |
| 用户天然只跟 B 说话 | **主推流程是用户直接跟 C 说话**，B 只在多项目迷路时用 |
| D 只是 C 内部跑的东西，用户碰不到 | D **可以直接对话**，退化成普通 Agent 用法 |
| 派活一次一问一答 | 用户连发多条，B/C **不打断**，判断冲突后决定并行还是覆盖 |

一句话概括偏差：**前一版把"项目助理"降级成了"任务执行器"，而它应该是"项目的主人"。**

---

## 1. 四个角色的准确职责

| 角色 | 我给的定位 | 生命周期 | 谁能对它说话 |
| --- | --- | --- | --- |
| **A 用户** | 唯一的人 | — | 对 B、对 C、对 D 都能说话 |
| **B 全局助理** | 跨项目路由器。**不执行、不占有项目** | 全局唯一、常驻 | 用户 |
| **C 项目助理** | 某个项目的**负责人**。拆任务、派 D、汇报、主动推进 | **一项目一 C，随项目常驻** | 用户、B |
| **D 执行 Agent** | 干具体活的执行者，有独立工作会话 | 由 C 按需创建，一事一 D，可回收 | C（派活/追问）；用户（直连对话） |

三者关系里唯一不可让渡的约束：

> **B 不与 D 直接通信，只与 C 通信。** 否则跨项目汇总会在 B 里出现两套并行状态，必然对不上账。

---

## 2. 主推流程走一遍（逐跳落到 dsh 原语）

```
用户新建项目或打开已有项目
   └─ 插件建项目记录 → 创建一个常驻 C 会话（preset=project-assistant，cwd=项目根）
用户对 C 说："把登录页重构一下"
   └─ C 回复一条（不阻塞），C 调 D 的工具开 D
      └─ C 调 start_agent → 子代理（preset=task-executor，cwd=项目根）
用户又说（C 还没答完）："顺便看看导出为什么卡住"
   └─ 消息进 C 的 inbox（followup/steer，见 §4），C 当前这轮不被打断
   └─ C 判断：两件事不冲突 → 再开第二个 D，并行
D#1 先完成
   └─ C 收到通知 → 立刻向用户汇报 D#1 的结果
   └─ 不等待 D#2
D#2 中途卡住（需要用户决策）
   └─ C **不空等**：先自己推进能推进的部分，把真正需要人的问题攒出来
   └─ 无法自行推进时，向用户提一个具体问题（一次只问一件）
```

**这条流程里每一跳对应的 dsh 原语（已核实的）：**

| 跳 | 原语 | 依据 |
| --- | --- | --- |
| 建常驻 C 会话 | `ctx.agents.createAgent(ownerCtx, { sessionId, meta: { cwd, agentPreset }, agentOptions, setup })` → `AgentHandle` | `dsh-agent` `CreateAgentOptions` 有 `meta.cwd` / `meta.agentPreset`；owner 持有 `AgentHandle`，可 `dispose()` |
| C 开 D | `ctx.subagents.startActivation({ provider:'spawn', label, request:{ parent, cwd, agentPreset, prompt }, signal, delivery })` | `dsh-subagent` `SubagentActivationSpec`；`request.parent` 是**活 Agent 对象** |
| D 完成通知回 C | `delivery: 'parent'` → C 会话里追加一条 user-role 结算通知 | `dsh-subagent`「Settlement notice」段 |
| C 在 D 卡住后继续推进 | C 自己可以收 `sendMessage` 给直接子代理 / 派新 D / 自己调工具 | `dsh-subagent`「Messaging」段：父可与直接可续子代理互发 |
| 用户连发不打断 | `agent.followup(message)`（排队成下一轮）或 `agent.steer(message)`（当前轮的下一步插入） | `dsh-agent` `AgentRuntime`：`followup` 排队后续轮次，`steer` 在最近一步边界消费 |
| 拿 C/D 的活 Agent 以发消息 | `ctx.agents.get(sessionId): Agent \| undefined` | `dsh-agent` `AgentRegistry.get` |

这五条全部有类型定义支撑，不是推测。

---

## 3. 三条流程各自的成立条件

### 3.1 主推流程（用户 ↔ C ↔ D）：成立

关键在 **C 必须是常驻 Agent，不能是一次性子代理**。

- C 若由 `startActivation` 创建，它就是"某次 activation 的子代理"：`result` settle 后这条 activation 就结束了，父会话再给它发消息要靠冷恢复，语义扭曲且容易翻车。
- C 作为**根 Agent**（`createAgent` 且不带 `parentAgent`）则由插件通过 `AgentHandle` 持有，可随时 `ctx.agents.get(cId)` 取回再 `followup`。这是正确形态。

**代价（必须说清）**：C 是根 Agent，就**不属于任何"父树"**。凡是依赖父子树的能力，C 都用不上：

| 依赖父树的能力 | C 能用吗 |
| --- | --- |
| `subagent` 结算通知自动进父会话 | C 是 D 的父，没问题 ✅ |
| 父树整体 `dispose()` 收敛 | ❌ 不存在，要插件自己管 C 的 `AgentHandle` |
| `maxActiveSubagents` 的"每棵树"配额 | C 是树根，消耗 0 槽位，D 才占槽位 ✅ 正好 |
| 关停时回收 | 插件在 `ctx.effect` 里 `dispose` 所有 C 的 handle ✅ |

### 3.2 其他流程 B（多项目迷路时问 B）：成立，但要收窄

B 的职责必须收窄成**"路由"**，不能变成"第二个执行者"：

- B 能做的：查项目列表、判断"你说的这件事像哪个项目"、建议去哪个 C、必要时**替用户把话转给那个 C**（`ctx.agents.get(cId).followup(...)`）。
- B **不能**做的：自己派 D、自己改代码、替 C 汇报"已完成"。

**B 与 C 之间是否互通，已于 §7 决策点 D1 拍板**：B 可以替用户把原话转交给 C，但绝不代 C 汇报。

### 3.3 其他流程 D（用户直连 D）：成立，但有个硬限制

用户可以直接和某个 D 对话，前提是**D 仍活着**。

> ⚠️ **硬限制**：D 是一次 activation 的子代理。它 `result` settle 之后，这条 activation 就结束了。
> 之后要继续跟它说话，只能走**冷恢复**（`resume`），而冷恢复要求：
> ① 会话已持久化；② `ctx.sessionQuery` 可用；③ `setup` 能重新组装它的 preset。
> 冷恢复在 `dsh-subagent` 里是被支持的，但**用户直连 D 这个交互形态需要单独验证**（§6 P0-T3）。

所以 D 流程的产品措辞要诚实：**"D 完成后你可以继续追问它，它会带着原来的上下文接着干（需要一次加载）"**，而不是"随时切回 D 聊天"。

---

## 4. 「连发不打断」到底怎么做

这是你的设想里技术上最需要小心的一条。dsh 提供了三个不同的入口，**语义完全不同**：

| 入口 | 语义 | 是否打断当前轮 | 适用 |
| --- | --- | --- | --- |
| `agent.followup(msg)` | 排成**下一轮**的唯一普通消息，并唤醒 driver | 不打断 | ✅ 用户连发的默认选择 |
| `agent.steer(msg)` | 插到**当前轮的最近一步边界** | 不打断，但会被当前轮看到 | 用户明确说"等等，改一下" |
| `agent.cancel(cause)` | **打断**当前轮并清空队列 | 打断 | 只在用户明确要停 |

**产品口径（建议）**：

1. 用户新消息默认走 `followup`，**永远不打断**。
2. 只有当用户消息被判定为"冲突且必须立刻改方向"时，才走 `steer`。
3. 只有用户点"停止"才 `cancel`。

**"冲突判定"由谁做？** 由 C 自己做，因为 C 有项目上下文。做法是给 C 一个明确的任务：

```
C 每收到一条新用户消息，先回答一个问题再动手：
  这条消息和"我正在做的事"是冲突，还是并列？
  - 并列 → 开新 D，两个一起跑
  - 冲突 → 按新消息调整：能改就改现有 D 的指令（sendMessage 给那个 D），
           改不了就取消那个 D 并按新消息重开
```

这条必须写进 C 的 preset 提示词，并且**判错的代价要落在明面上**：C 判成"并列"其实冲突了，结果就是两个 D 改同一批文件。所以还要有一条工程兜底（见 §8 写域互斥）。

---

## 5. 数据模型

### 5.1 角色实体

```ts
// 项目：一个工作目录 + 一个常驻 C
interface ProjectRow {
  id: string;                 // prj_xxx
  name: string;
  rootPath: string;           // 归一化小写
  assistantSessionId: string | null;  // C 的会话 id（B 与用户都靠它定位 C）
  assistantPreset: string;    // 默认 project-assistant
  createdAt: string;
  updatedAt: string;
  archived: 0 | 1;
}

// 执行者：一个 D
interface ExecutorRow {
  id: string;                 // exe_xxx
  projectId: string;
  sessionId: string;          // D 的子会话 id
  label: string;
  goal: string;               // 派给 D 的目标（可读版）
  status: 'starting' | 'running' | 'idle' | 'done' | 'failed' | 'cancelled';
  /** D 跑完后能否被用户继续追问：依赖会话持久化与 sessionQuery */
  resumable: 0 | 1;
  writeScope: string;         // 写域声明，用于并行冲突检测
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

// 对话轮：用来做"冲突判定"和"谁先完成先报谁"
interface TurnRow {
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'system';
  source: 'webapp' | 'im' | 'assistant';
  text: string;
  /** 用户消息被判定为：新增 / 与在跑任务并列 / 与在跑任务冲突 */
  judged: 'new' | 'parallel' | 'conflict' | null;
  createdAt: string;
}

// 汇报：C 向用户汇报的每一条
interface ReportRow {
  id: string;
  projectId: string;
  executorId: string | null;
  kind: 'progress' | 'blocked' | 'done' | 'failed' | 'question';
  body: string;
  needsUser: 0 | 1;
  createdAt: string;
  ackedAt: string | null;
}
```

### 5.2 为什么这几张表

- `ProjectRow.assistantSessionId` 是**整个架构的锚点**：有它，B 和用户都能找到这个项目的 C；没它，C 就是一个找不到入口的孤儿会话。
- `ExecutorRow.resumable` 直白记录"这个 D 能不能被用户接着聊"，避免 UI 骗人。
- `ExecutorRow.writeScope` 是并行安全的关键：两个 D 的写域相交时不让它们同时跑。
- `TurnRow.judged` 让"C 判错了"这件事**可审计**，后面能统计判定准确率。

---

## 6. 分阶段规划

原则：**每一阶段都有"能演示的东西"和"明确的验收方式"**，不攒大版本。

### P0：打通骨架，证明三层结构成立（1～2 天）　✅ 已完成

这一阶段不追求完整，只追求**证伪**——把最可能不成立的四个假设逐个打掉。

| 任务 | 要验证的假设 | 怎么验 | 不成立怎么办 |
| --- | --- | --- | --- |
| **P0-T1** C 作为根 Agent 常驻 | `createAgent` 建的根 Agent 能反复接收 `followup`，且 `ctx.agents.get` 能取回 | 建一个 C，发两条 followup，看是否两轮都答；重开插件后 `get` 仍能取回 | 退化为"每次 C 会话都走 `resume`"，代价是每轮多一次加载 |
| **P0-T2** C 收到 D 的通知后能继续做事 | `delivery:'parent'` 的通知进 C 后，C 能自动起一轮 | 让 D 用 3 秒跑完，观察 C 是否自动产生新一轮 | 插件在 D 结算回调里主动 `ctx.agents.get(cId).followup(总结)` |
| **P0-T3** 用户直连 D 的续聊 | D 结束后 `resume` 该会话，能带着上下文继续 | 让 D 做完，再 resume 问"刚才改了什么" | 产品降级为"查看 D 的完整记录"，不承诺续聊 |
| **P0-T4** 连发不打断 | `followup` 发第二条时，C 的第一轮不被中断 | 让 C 跑一个长任务，中途 followup，观察两轮都能完成 | 若 dsh 行为不符，改为插件维护自己的输入队列，在一轮结束后再 `followup` |

**P0 交付物**：`packages/dsh-bao` 里三个模块的最小实现 + 一份实测记录 `docs/verify/p0-findings.md`（每个假设：方法、实际结果、结论）。

**P0 验收**：四个假设全部有明确结论（成立或不成立），并且不成立的都走过了回退方案。

> 这个顺序是刻意的：P0 全部是**证伪成本极低**的验证。如果 P0-T1 或 P0-T2 不成立，整个三层架构要重新设计，越早发现越好。

### P1：主推流程可用（3～5 天）　✅ 已完成

| 任务 | 内容 |
| --- | --- |
| **P1-T1** 项目管理 | 新建项目 / 打开已有项目 / 项目列表；建项目时自动建 C 并写 `assistantSessionId` |
| **P1-T2** 项目助理 preset | `project-assistant`：拆任务、派 D、判断冲突、主动推进、按三段汇报 |
| **P1-T3** 执行 Agent preset | `task-executor`：只干一件确定的活，结论先行，不许再派人 |
| **P1-T4** C 的五个工具 | `spawn_executor` / `message_executor` / `list_executors` / `cancel_executor` / `report_to_user` |
| **P1-T5** 并行与写域 | 并行上限 **5**（配置项 `maxConcurrentExecutors`，可调且不超过 dsh 的 `maxActiveSubagents`）；两个 D 写域相交时排队而不是同时跑 |
| **P1-T6** 先完成先汇报 | D 结算 → 立即汇报，不等兄弟 |

**P1 验收**（可直接演示）：
1. 新建项目 A，对 A 的 C 说"做登录页重构"，C 回复后 D 开始跑。
2. C 还在跑时，用户再发"顺便查导出"，第二个 D 并行起来，第一个不被打断。
3. D#1 先完成，用户**立刻**收到 D#1 的汇报，D#2 还在跑。
4. 两个 D 都完成后，C 给一份汇总（三块：做了什么 / 卡点 / 待你决定）。

### P2：B 全局助理（2～3 天）　✅ 已完成

| 任务 | 内容 |
| --- | --- |
| **P2-T1** B 的定位收窄 | B 只有"路由 + 汇总"两类动作，工具只给 `list_projects` / `find_project` / `handoff_to_assistant` |
| **P2-T2** 项目路由 | 用户一句话目标 → B 判断属于哪个项目，给出依据（项目名/路径/最近任务命中） |
| **P2-T3** 转交 | 按 §7.1 的边界实现 `handoff_to_assistant`：**原话原样** `followup` 给对应 C，不许 B 改写；转交失败如实回报；命中依据不足时反问而不是硬猜 |
| **P2-T4** 跨项目汇总 | 用户问"都在干什么" → B 读所有项目的状态，给一份按项目分组的简报 |

**P2 验收**：
- 有 3 个项目时，用户对 B 说"把文档那事推进一下"，B 指出是哪个项目、为什么，并把**原话**转给对应 C。
- 用户问"现在都在干什么"，B 给出分组简报，且**不编造**没发生的事。
- 反例必须成立：B 被要求"直接把登录页改了"时，**拒绝执行并转交**，而不是自己动手（§7.1 的禁止项）。
- 反例必须成立：两个项目命中依据等分时，B **反问用户**而不是二选一硬转。

### P3：用户直连 D（2 天）　✅ 已完成

| 任务 | 内容 |
| --- | --- |
| **P3-T1** D 的会话保留 | D 结束后不销毁会话，`resumable` 置 1（依赖 P0-T3 结论） |
| **P3-T2** 追问入口 | 用户在界面上选中某个 D 继续对话，消息直接 `followup`/`resume` 给 D |
| **P3-T3** 越权防护 | 用户直连 D 时，D 仍然只在本项目写域内、不能越权；与 C 的调度不打架 |

**P3 验收**：D 做完一件事后，用户对 D 说"把刚才那处再改严格点"，D 能带着原上下文继续；同时 C 知道这次改动。

### P4：主动推进与卡点处理（3 天）　🟡 部分完成

这是你设想里很关键的一条："D 遇到突发问题暂停，C 主动继续推进，直到完成。"

| 任务 | 内容 |
| --- | --- |
| **P4-T1** 卡点分类 | 把 D 的卡点分成三类：① 自己能解决的（重试/换法） ② 必须问用户的 ③ 环境问题（缺依赖/权限） |
| **P4-T2** 主动推进策略 | ① 类：C 直接给 D 发新指令或重开 D，不打扰用户；② 类：攒成一个具体问题问用户；③ 类：如实报告并给修复建议 |
| **P4-T3** 规则兜底 | 移植旧仓库已有的 `supervision` 规则（见 §9）：空转完成、重复调用、长时间无进展、越权写入 |
| **P4-T4** 汇报去抖 | 同一件事不反复打扰用户；多个 D 同时完成时合并成一条汇报 |

**P4 验收**：让 D 故意失败一次（如改一个不存在的文件），C 不打扰用户先自行换法重试；重试仍失败时才问用户，并且只问一个具体问题。

### P5：记忆与白盒（3 天）　🟡 部分完成

| 任务 | 内容 |
| --- | --- |
| **P5-T1** 项目规则文件 | `<project>/.opencoxswain/rules.md`，C 每轮注入 `systemPrompt.section` |
| **P5-T2** 每日日志 | `<project>/.opencoxswain/journal/YYYY-MM-DD.md`，只追加 |
| **P5-T3** 检索 | 中文二元组 + 位置打分（旧仓库 `packages/memory/tokenize.ts` 可直接搬） |
| **P5-T4** 提炼 | `distill`：日志 → 规则，原日志保留并标记 |

> 注意：`systemPrompt.section` 的 `render` 是**每轮都会执行**的，文件读盘要在里面做缓存，否则每轮都在读盘。

### P6：看板与 IM（4 天）　🟡 部分完成（界面已做，IM 未做）

| 任务 | 内容 |
| --- | --- |
| **P6-T1** 项目看板 | 项目列表 → 每个项目的 C 状态、在跑的 D、最近汇报、待决策项 |
| **P6-T2** D 的可视化 | 每个 D 的进度、写域、产出摘要 |
| **P6-T3** IM（飞书优先） | 入站验签 + 事件去重 → 转给对应 C；出站汇报 |

---

## 7. 产品决策（已拍板，2026-11-11）

以下是已经确认的决策。**代码与提示词均以本节为准**，不再反复。

| # | 决策 | 结论 |
| --- | --- | --- |
| **D1** | B 与 C 之间是否互通 | **已定：B 可以替用户把原话转交给 C，但绝不代 C 汇报。** B 只做"指路 + 转交"，三件事明确禁止（见 7.1） |
| **D2** | C 是否允许同时跑多个 D | **已定：允许并行，默认上限 5，用户可调。** 见 7.2 的配额约束与互斥配套 |
| **D3** | 用户直连 D 后，C 是否知道 | **已定（2026-11-11 用户重申）：C 知道。** 用户要求"用户可直接和 D 对话，自行推进项目"，而 C 负责汇报，若 C 不知情则汇总必与事实不符。用户直连 D 的每轮消息落 `TurnRow(source=webapp, executorId=D)`，并在 D 结算时一并进入 C 的汇报材料 |
| **D4** | C 的汇报节奏 | **已定（2026-11-11 用户重申）：谁先完成先报谁，每个 D 完成立刻一条，同一批同时完成合并成一条。** 用户原话："D 与 D 之间互不影响，谁先完成，C 就先汇报谁的结果" |
| **D5** | 关掉软件后 C 的记忆 | **已定（2026-11-11 用户重申）：完整恢复。** 用户流程是"进入软件 → 打开已有项目 → 继续对 C 说"，因此 C 必须带着原上下文恢复；恢复失败才降级为"规则 + 日志 + 摘要"，且必须如实告知用户降级了 |

### 7.1 D1 的边界（已定）

B 的能力清单就是这三条，多一条都不给：

| B 可以 | B 不可以 |
| --- | --- |
| `list_projects`：列出项目及其 C 的状态 | 自己派 D（一律禁止） |
| `find_project`：判断用户的话属于哪个项目，**必须给出依据**（项目名/路径/最近任务命中） | 自己改代码、自己跑构建 |
| `handoff_to_assistant`：把用户**原话原样**转交给目标 C（`ctx.agents.get(cId).followup(...)`） | 代 C 汇报"已完成"，或替 D 下结论 |

三条工程后果，必须一起做：

1. **转交的是原话，不是 B 的复述。** B 一旦改写用户的原话，C 就会在错误的前提上开工。`handoff_to_assistant` 的参数就是这个原始字符串，B 不允许加工。
2. **B 必须回报转交结果。** 转交失败（C 不存在、C 的 handle 已 disposed、转交被拒）要如实告诉用户，而不是回一句"已经帮你转达了"。
3. **B 不能"猜项目"硬转。** 命中依据为空或存在多个等分候选时，B 必须反问用户，而不是挑一个转过去——转错项目的代价是 C 在错误的仓库里开工。

### 7.2 D2 的配额约束（已定：默认 5）

选 5 的**前提**是下面两条约束同时成立，否则 5 个 D 会互撞：

- **dsh 侧配额**：`maxActiveSubagents` 默认 8 / 每棵树。C 是根 Agent、消耗 0 槽位，D 占槽位。5 < 8，**不会触发 `ACTIVATION_LIMIT_REACHED`**。⚠️ 但这是"默认 8"；如果部署方把这个值调低过，插件必须在启动时读一次并在超限时给出可读原因，而不是等派活时才硬失败。
- **写域互斥必须与上限同时上线。** 5 个 D 并行时，同写一批文件几乎必然发生。规则：两个 D 的 `writeScope` 相交 → 排队；声明不了写域的 D → 视为与所有写任务冲突，串行。
- **上限可调**：`maxConcurrentExecutors` 配置项，默认 5，上限不超过 dsh 的 `maxActiveSubagents`。用户调大时插件要提示"超过 dsh 配额会直接失败"。

> 为什么不是无限：5 是并行的**有效上限**而不是安全上限。再高，写域冲突导致的排队比并行收益更多，而且 C 的汇总负担陡增（同时完成 8 个 D，用户没法看）。

### 7.3 D1 的落地细节：转交怎么实现

```ts
// B 的 handoff_to_assistant 工具
async execute({ projectId, userText }) {
  // 1) 校验项目存在且有常驻 C
  const project = store.getProject(projectId);
  if (!project) return { ok: false, reason: `项目 ${projectId} 不存在` };
  if (!project.assistantSessionId) {
    return { ok: false, reason: `${project.name} 还没有项目助理，请先在项目里打开一次` };
  }

  // 2) 取活的 C。取不到说明插件重启过、C 尚未恢复。
  const assistant = ctx.agents.get(project.assistantSessionId);
  if (!assistant) {
    return { ok: false, reason: `${project.name} 的项目助理当前未加载，请打开该项目后再试` };
  }

  // 3) 原话投递：不加工、不摘要、不补充 B 自己的理解。
  assistant.followup(userMessage(userText, { source: 'global-assistant-handoff' }));

  return { ok: true, projectId, project: project.name };
}
```

四点必须注意：

1. **`followup` 不是 `steer`。** 转交的话不能被当成"插队指令"打断 C 正在进行的工作，它应该排在 C 当前这轮之后的下一轮。
2. **`ctx.agents.get()` 返回 `Agent | undefined`，取不到是常态而不是异常。** 插件重启后 C 尚未恢复、或 C 的 handle 已被 disposed，都会返回 undefined。这种情况要如实回报"项目助理当前未加载"，而不是抛异常或假装成功。
3. **不产生"第二套状态"。** 转交成功后 B 不记录"我已让 C 去做 X"这类状态，因为真相在 C 那边。B 只回报"已转交"，之后用户问进度，B 去 C 那里读，而不是读自己的记忆。
4. **C 恢复的责任在项目打开流程，不在 B。** B 发现 C 未加载时，可以触发一次恢复（`resume`），但恢复失败必须把原因透传给用户——不能静默吞掉。



---

## 8. 已知的硬限制与工程兜底

诚实列出，这些不是"注意一下"就能绕过的。

| # | 限制 | 影响 | 兜底 |
| --- | --- | --- | --- |
| L1 | **D 完成后不能随时续聊**，要冷恢复 | D 流程的产品承诺 | P0-T3 先验证；不成立就把 D 定位成"可查看的历史" |
| L2 | **C 是根 Agent，不属于任何父树** | 没有统一的"父树 dispose" | 插件自己持有 `AgentHandle`，在 `ctx.effect` 里逐个 dispose |
| L3 | **`sendMessage` 要求精确的活发送方 + 直接可续子代理** | 用户直连 D 时，发送方不是 C，可能被拒 | P3 里改用 D 自己的 Agent 作为 sender，或走 resume 路径 |
| L4 | **C 自己判错"冲突"会导致两个 D 同改一个文件** | 数据被覆盖 | 写域互斥（P1-T5）；两个 D 写域相交时排队 |
| L5 | **dsh 的 `maxActiveSubagents` 超限直接拒绝**（每棵树，默认 8） | 并行上限若超了会硬失败 | 插件自建闸门，上限默认 5 严格落在 dsh 默认配额 8 之内；启动时读一次实际配额，超限给可读原因 |
| L6 | **子代理收尾文本可能被省略**（结束时最后动作是给父发消息） | C 拿不到 D 的结论 | preset 里写死"先结论、不要用发消息结尾"；D 的正文以插件侧记录为准 |
| L7 | **会话创建/恢复依赖 `sessionPersistence`** | 没配持久化，C 与 D 都退化成一次性 | 插件启动时探测，缺了就拒绝启动并说明 |
| L8 | **本机 dsh 的 asar 被占用，且已剥掉 `.d.ts`** | 无法在运行时核对类型 | 已改为从公共 registry 安装真实类型包；`src/host.ts` 保留运行时探测兜底 |

---

## 9. 旧仓库里可以直接拿来用的资产

不是全推倒。下面这些是旧自研路线已经写好、且与 dsh 不冲突的：

| 资产 | 位置 | 用在哪 |
| --- | --- | --- |
| 中文二元组分词与检索 | `packages/memory/src/tokenize.ts`、`search.ts` | P5 记忆检索 |
| 记忆写入闸门（拒绝临时指令、疑似密钥、过短内容） | `packages/memory/src/gate.ts` | P5 防止规则文件被污染 |
| 规则监察（空转完成、重复调用、无心跳、越权写入） | `packages/core/src/supervision.ts` | P4-T3 主动推进的兜底 |
| 能力化授权（`fs.read` / `fs.write` / `net.send`） | `packages/core/src/mandate.ts` | P1 写域与 P3 越权防护 |
| 副作用台账与幂等键 | `packages/core/src/side-effect.ts` | P4 重试时不重复产生副作用 |
| 验收策略三档 | `packages/core/src/acceptance.ts` | P4 判断 D 是否真的完成 |

**不拿来用的**：整个 `apps/daemon`（HTTP/SSE + SQLite + 调度器 + worktree）与 `apps/desktop` 的工作台。它们重造了 dsh 已经有的会话/工具/沙箱/调度/UI 插槽，正是上一版偏差的根源。

---

## 10. 目录结构（P0～P2 目标形态）

```
packages/dsh-bao/
  package.json
  cordis.patch.yml
  presets/
    project-assistant.yml     # C
    task-executor.yml         # D
    global-assistant.yml      # B
  src/
    index.ts                  # 装配 + 宿主探测 + 关停收敛
    config.ts
    domain.ts                 # project / executor / turn / report 四张表
    store.ts                  # 表之上的一层
    host.ts                   # 宿主能力边界（含运行时探测）
    project/
      manager.ts              # 建项目 + 建常驻 C + 记录 assistantSessionId
      tools.ts                # 用户侧/UI 侧的项目操作
    assistant/                # C
      lifecycle.ts            # 持 C 的 AgentHandle、取回、followup 投递
      tools.ts                # spawn_executor / message_executor / list_executors / cancel_executor / report_to_user
      judge.ts                # 冲突判定（并行 / 冲突）
    executor/                 # D
      runner.ts               # startActivation 封装、结算、先完成先汇报
      resumable.ts            # 冷恢复与可续标记
      scope.ts                # 写域解析与互斥
    global/                   # B
      router.ts               # 项目路由与依据
      tools.ts                # list_projects / find_project / handoff_to_assistant
    inbox/
      queue.ts                # 连发不打断：followup 排队与合并
    test/
```

**关键设计**：`assistant/` 与 `executor/` 分开，而不是像上一版把两者都塞进 `orchestrator/`。因为它们现在是**两种不同生命周期的实体**（根 Agent vs 子代理），混在一起必然写出 C 被当子代理处置的 bug。

---

## 11. 验收总表

| 阶段 | 能演示什么 | 判定标准 |
| --- | --- | --- |
| P0 | 四个假设的实测记录 | 每条都有成立/不成立结论 + 回退验证 |
| P1 | 主推流程跑通 | §6 P1 的四条验收全部做到 |
| P2 | 多项目时 B 帮用户找 C | B 的指路依据可核查；转交的是**原话**；B 不越权执行；依据不足时反问 |
| P3 | 用户直连 D 续聊 | D 带上下文继续，C 知情 |
| P4 | D 卡住时 C 自己先推进 | 不打扰用户的前提下完成率可测；确实要问时只问一件 |
| P5 | 项目规则生效 | 手改 `rules.md`，下一轮 C 立即按新规则行事 |
| P6 | 看板 + 飞书 | 从飞书发一句话能把活派下去并收到汇报 |

---

## 12. 立刻要做的第一件事

**不写新功能，先跑 P0 的四个验证。** 顺序和理由：

1. **P0-T1（C 常驻）**：不成立的话，整个"项目助理"概念要重做。
2. **P0-T2（D 完成通知进 C）**：不成立的话，"先完成先汇报"要改成插件主动注入。
3. **P0-T4（连发不打断）**：不成立的话，§4 的整个交互设计要改。
4. **P0-T3（D 可续）**：这一条影响的是产品承诺口吻，可以最后验。

四个都过了，再按 P1 开始搭主推流程。

**P0 额外补一项验证（归入 P0-T1 一起做）**：`ctx.agents.get(cId)` 在**插件重启后**能否取回仍未恢复的 C——这直接决定 §7.3 里 B 转交时"项目助理当前未加载"这条分支是否真的会出现。如果不出现（比如重启后 C 一定被自动恢复），§7.3 的第 2 点分支就要删掉。

---

## 13. 决策依据摘要（供评审）

| 你提出的要求 | 落在哪 | 依据 |
| --- | --- | --- |
| 用户直接对 C 发任务 | §2、§3.1 | C 用 `createAgent` 建成**根 Agent** 并持有 `AgentHandle`，可反复 `followup` |
| C 调 D 执行 | §2、P1-T4 | `ctx.subagents.startActivation({ provider:'spawn', request:{ parent: C, cwd, agentPreset, prompt } })` |
| C 可同时调多个 D 并行 | §7.2、P1-T5 | 自建闸门默认 5；dsh `maxActiveSubagents` 默认 8，C 占 0 槽位 |
| 谁先完成先汇报谁 | §6 P1、D4 | `delivery:'parent'` 每个 D 独立结算，互不等待 |
| D 遇阻，C 主动推进 | §6 P4 | C 可对直接子代理发 `sendMessage`、可重开 D、可自己调工具 |
| 用户连发不打断 | §4 | `followup()` 排队成下一轮；`steer()` 只在冲突时用 |
| 冲突则按新需求，不冲突则并行 | §4、P1、`judge.ts` | C 判定 + `TurnRow.judged` 留痕 + 写域互斥兜底 |
| B 引导用户找对 C | §7.1、§7.3、P2 | B 三个工具；转交原话；不代汇报 |
| 用户可直接和 D 对话 | §3.3、P3 | D 结束走冷恢复 `resume`；受 L1 限制，P0-T3 先验 |
