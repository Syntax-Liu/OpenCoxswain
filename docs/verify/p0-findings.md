# P0 验证记录：四个关键假设

> 对应方案：[`../self-developed-plan.md`](../self-developed-plan.md) §6 P0、§12。
> 结论时间：2026-11-11。
> 证据基线：本机 `node_modules` 中实际安装的 `@deepseek-ai/dsh-agent@0.2.2-rc.1`、
> `@deepseek-ai/dsh-subagent@0.2.2-rc.1` 的公开 `.d.ts`。凡引用均标注文件与行号，
> 不接受"理论上可以"。

> ## ⚠️ 时效性说明（2026-11-11 晚补注）
>
> 这份记录是在 **dsh 作为宿主** 的前提下做的。此后用户明确要求产品
> **不依赖 dsh**，实现已改为自研运行时（`apps/runtime`）。
>
> **本文仍然有效的部分**：四个假设描述的**产品行为事实**全部成立，且已在自研版中重新实现并验证：
>
> | 假设 | 在自研版中的对应实现 | 验证 |
> | --- | --- | --- |
> | P0-T1 C 常驻 | `AssistantSession`（一项目一会话，历史在 SQLite） | `recover.test.ts` |
> | P0-T2 D 完成通知进 C | `notifyAssistant` → Inbox（`internal` 标记） | `purity.test.ts` |
> | P0-T3 用户直连 D | `userSaysToExecutor`（带 `priorMessages` 续跑） | `dchat.test.ts` |
> | P0-T4 连发不打断 | `Inbox` 的 `next` / `step` 双队列 | `runtime.test.ts` |
>
> **本文不再适用的部分**：所有 `ctx.agents` / `startActivation` / `delivery:'parent'`
> 等 dsh 原语的引用——自研版不依赖这些 API，而是实现了等价行为。
> 保留这些引用是因为它们解释了"为什么要这样设计"。

## 结论总表

| 假设 | 结论 | 影响 |
| --- | --- | --- |
| **P0-T1** C 作为根 Agent 常驻，可反复 `followup`，`ctx.agents.get` 可取回 | ✅ **成立** | "用户直接对 C 说话"的主推流程成立，C 不需要重建 |
| **P0-T2** D 完成通知进入 C 并自动起一轮 | ✅ **成立** | "先完成先汇报"可直接用宿主能力，无需插件注入 |
| **P0-T3** 用户直连 D 的续聊（冷恢复） | ✅ **成立**（有前提） | 产品可承诺"D 完成后可继续追问"，但需持久化 + `sessionQuery` |
| **P0-T4** 连发不打断 | ✅ **成立** | 用户连发默认走 `followup`，永不打断 |

**结论：四个假设全部成立，四层架构不需要重新设计。**

---

## P0-T1：C 作为根 Agent 常驻

**假设**：`createAgent` 建的根 Agent 能反复接收 `followup`，且 `ctx.agents.get` 能取回。

**证据**：

1. `AgentRegistry.create(options: CreateAgentOptions): Promise<AgentHandle>`
   —— `dsh-agent/lib/types/index.d.ts:292`
2. `CreateAgentOptions.parentAgent?: Agent` 的注释是 **"Live parent Agent for runtime ownership; omit for a root Agent."**
   —— `index.d.ts:52`。**省略即根 Agent**，正是 C 需要的形态。
3. `CreateAgentOptions.meta.agentPreset?: string` 与 `meta.cwd?: string`
   —— `index.d.ts:65-72`。C 的 preset 与工作目录在建会话时确定。
4. `AgentHandle { agent: Agent; dispose(): Promise<void> }`
   —— `index.d.ts:145-148`。注释明确："the handle is exposed only to the consumer owner that created it"，即**插件自己持有 C 的 handle 并负责 dispose**（对应方案 L2 的兜底）。
5. `followup(message: UserMessage): void`："Queue an ordinary follow-up turn and wake the driver."
   —— `runtime-types.d.ts:219`。可反复调用，每次成为独立一轮。
6. `AgentRegistry.get(id: SessionId): Agent | undefined` —— `index.d.ts:357`。取不到返回 `undefined`（方案 §7.3 的分支依据）。

**结论：成立。** C 用 `ctx.agents.create({ sessionId, meta: { cwd, agentPreset } })`（**不传 `parentAgent`**）创建为根 Agent，插件持有 `AgentHandle`，之后用 `ctx.agents.get(cId)?.followup(...)` 反复投递。

**补充验证（方案 §12 要求）**：`get()` 在**插件重启后**能否取回未恢复的 C？
—— 不能，且这是**预期行为**：`agent/disposed` 在 Agent 离开注册表时发出（`runtime-types.d.ts:267`），进程重启后注册表为空。
因此 §7.3 的"Assistant当前未加载"分支**真实存在，必须保留**；恢复 C 的责任在"打开项目"流程（用 `ctx.agents.resume({ resumeSessionId })`）。
这与方案 §7.3 第 4 点一致，无需修改。

---

## P0-T2：D 的完成通知进入 C 并自动起一轮

**假设**：`delivery: 'parent'` 的结算通知进 C 后，C 能自动产生新一轮。

**证据**：

1. `SubagentActivationSpec` 的 `delivery: 'parent' | 'caller'`
   —— `dsh-subagent/lib/types/activation.d.ts:31`。
2. `createSettlementMessage(childId, terminal, continuable?, omitClosingText?)`
   —— `continuation-messages.d.ts:64`。注释：**"Build the runtime-owned settlement notice from the child's nonempty closing text."**
   这是**运行时自己**构造并投递到父会话的 user-role 消息，不是子代理写的。
3. `SubagentSettledMessageSource` 的注释明确区分语义：
   "an Agent message is content the sender chose, while this message is the manager stating what became of the child"
   —— `continuation-messages.d.ts:19-26`。
4. `notifySettlement`（`manager.d.ts:216`）："**Deliver** the captured execution result to the durable direct parent after cleanup."
   —— 由 manager 在子代理收敛后投递。

**结论：成立。** D 用 `delivery: 'parent'` 启动，结算通知由 dsh 自己投递给 C，**不需要插件手工 `followup` 注入**。

**但两个坑必须处理**（方案 L6 已预见，这里补充精确机制）：

- `omitClosingText` 的判定条件在 `activation.d.ts:66-71`：
  "true while the child's **last logged tool call was a message to its direct parent** and no input was claimed since."
  也就是说：**D 如果最后一步是给 C 发消息，它的收尾文本会被省略**，C 只看到"子代理已结算"而没有结论。
  → D 的 preset 必须写死"**不要用发消息结尾，结论放在收尾文本**"（已写入 `task-executor.yml`）。
- 结算通知是**每个 D 独立投递**的（每个 activation 独立 `result` 与 `notifySettlement`），因此"谁先完成先汇报谁"是宿主原生行为，**不需要插件排序**。

---

## P0-T3：用户直连 D 的续聊

**假设**：D 结束后 `resume` 该会话，能带着上下文继续。

**证据**：

1. `coldResume`（`manager.d.ts:230-234`）："**Cold-resume a persisted child and submit the waiting turn.** The descriptor supplies every reconstruction input; no subagent provider is dispatched."
2. `sendMessage` 注释："... and an **absent direct child cold-resumes from persistence**."
   —— `dsh-subagent/lib/types/index.d.ts:155-159`。
3. **前提（硬要求）**：`requirePersistence`（`manager.d.ts:241-242`）："Resolve the persistence service continuable children require, **or fail loud**."
   —— 没有 `sessionPersistence` 就没有冷恢复。
4. 协议错误码已定义：`subagent/not-resumable`、`subagent/delivery-unavailable`
   —— `control-types.d.ts:125-139`。即失败是**可读、可回报**的。

**结论：成立，但有前提。**
- 冷恢复依赖 `sessionPersistence` + `sessionQuery`，插件启动时必须探测（方案 L7），缺了就拒绝启动并说明。
- 产品措辞按方案 §3.3：**"D 完成后你可以继续追问它，它会带着原来的上下文接着干（需要一次加载）"**，不说"随时切回 D 聊天"。

**对用户设想的落地**：用户要求"D 可以直接和用户对话，此流程和市面上大多数 Agent 一致"。续聊成立，因此 `ExecutorRow.resumable` 在 D 结算后置 **1**（有持久化时），UI 据此开放追问入口。

---

## P0-T4：连发不打断

**假设**：`followup` 发第二条时，C 的第一轮不被中断。

**证据**：

1. `followup(message)`："Queue an **ordinary follow-up turn** and wake the driver. **The item becomes the sole ordinary message of its own turn.**"
   —— `runtime-types.d.ts:219-220`。排队成下一轮，不进入当前轮。
2. `Agent.inbox` 的两条队列注释：
   - `nextTurn`："Prompts awaiting individual turns."
   - `nextStep`："Input awaiting the next step boundary."
   —— `runtime-types.d.ts:68-70`。
   `followup` 进 `next-turn` 队列，**不触碰当前轮**。
3. 对比 `steer(message)`："A running driver consumes it at its **next step boundary**."
   —— `runtime-types.d.ts:221-227`。这才是会被当前轮看到的入口。
4. 对比 `cancel(cause, options)`："Clear queued and steering work — unless keepInbox — and **abort the active turn**."
   —— `runtime-types.d.ts:184`。这才是打断。

**结论：成立。** 三个入口语义完全分离：
- `followup` → 下一轮，**不打断**（用户连发的默认选择）
- `steer` → 当前轮下一步，不打断但会被看到（只在"冲突且必须立刻改方向"时用）
- `cancel` → 真打断（只在用户点停止时用）

---

## 对实现的影响

1. **C 必须用 `create` 而非 `startActivation`** —— 这是原 `orchestrator/runner.ts` 的根本偏差。
2. **D 的完成通知不需要插件注入**，但 D 的 preset 必须禁止"用发消息结尾"。
3. **重启后 C 不在注册表**是常态，"Assistant当前未加载"分支要如实回报。
4. **连发默认 `followup`**，冲突判定由 C 自己做（写进 `project-assistant` preset），插件用 `TurnRow.judged` 留痕。

## 仍未验证的部分（诚实声明）

以下在本机**无法**验证，因为需要真实 dsh 运行实例（当前 asar 被占用）：

| 项 | 状态 | 风险 |
| --- | --- | --- |
| 宿主接线（profile 装载 preset） | 未实测 | 首次真机接线可能需微调 `cordis.patch.yml` |
| 真实 LLM 下 C 的冲突判定质量 | 未实测 | 已用写域互斥兜底（L4） |
| 冷恢复在真实会话上的耗时 | 未实测 | 产品措辞已标注"需要一次加载" |

这些不阻塞代码构建，但**不能声称已验证**。
