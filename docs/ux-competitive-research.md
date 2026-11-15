# 使用体验深调研：同类 AI 编程工具怎么做，我们差在哪

> 写于 2026-11-15。触发：*"深度搜索同类 AI 编程工具产品的使用体验，比如完成某一项操作是要怎么做的，然后和我们的项目对比，找出可以优化的地方，着重看用户使用体验。"*
>
> **只谈体验，不谈新的大能力。** 能力面（并行、审批、验收、台账、记忆、Skill、MCP）我们没有落后；
> 这一份要说的是**用户拿这个软件真的干活时，每一步顺不顺**。
>
> 读法建议：§5 是结论与优先级，§1–§4 是支撑。赶时间就只读 §0 和 §5。

---

## 0. 一句话结论

> **我们的机制是超前的，界面是断的半截，而且很多"接口早就有、就是没接"——**
> **而"打断人"的方式正好是同类产品被骂得最惨的那一种。**

三个事实支撑这句话：

1. **同一个 UI 重构把整套交互一起删了。** `apps/web-legacy` 里有附件、命令面板、`@` 引用、消息重试/编辑、草稿、审批面板、待决策面板、轨迹页、回滚按钮、用量显示；
   `apps/web`（新界面，提交 `19439f8`）只有：对话流、输入框、跑道面板、执行者详情。
   后面那些**还在被测试覆盖**，但**用户点不到**（实测见 §1.4）。
   > 状态提醒：这是本文写作时的取证基线。此后另一个 Agent 已补回轨迹视图、消息复制/编辑/重试、待拍板卡片、审批面板。
   > 引用这些结论前请重新跑一遍 §1.4 的检查。
2. **"需要你拍板"当时只有一个按钮，而它不通向任何拍板动作。**
   `RunnerPanel` 的「查看并处理」绑的是 `onDecide={openExecutor}`——只是把执行者详情打开（`App.tsx:176`）。
   详情页没有输入框，没有暂停/继续，没有"我选 JWT"。用户唯一的解法是**退回对话页、手动打一段话**。
   > 状态提醒：并行工作的另一个 Agent 已经提交了 `DecisionCard.tsx`，这条正在被修。**以代码为准复核，别照抄本句。**
3. **审批是全局档位，不是按动作逐个确认。**
   `readonly`/`manual`/`auto`/`full` 四档，默认 `manual`。
   一旦用户为了少被打扰切到 `auto`，**删除、推送、发布、付款、外发全部一起放行**。
   这是调研里唯一被量化证明会出事的模式（§2.1 D2）。

---

## 1. 先看我们自己（全部核过代码/产物，不是印象）

### 1.1 新界面实际有什么

| 位置 | 内容 | 证据 |
| --- | --- | --- |
| 头部 | 品牌 · 项目下拉 · 路径 · 离线徽章 | `App.tsx:125-150` |
| 主区 | 对话流（Markdown、自动跟随底部） | `Transcript.tsx` |
| 主区 | 输入框（Enter 发送 / Shift+Enter 换行 / 自动长高） | `Composer.tsx` |
| 右栏 | 待拍板卡片 + 在跑跑道 + 已完成细线（**仅在有执行者时出现**） | `RunnerPanel.tsx`、`App.tsx:97` |
| 主区 | 执行者详情：目标、状态、步数、耗时、卡点、结论、验收清单 | `ExecutorFocus.tsx` |
| 头部 | 离线提示 | `App.tsx:145` |

**除此之外没有任何设置、引导、模板、搜索、附件、快捷键入口。**

### 1.2 死代码确认（写了，没接上）

`scripts/` 之外的所有界面代码里，下面这些函数**一次都没被调用**：

```
.stop(  .cancel(  .search(  .files(  .approvals(  .checkpoints(
.usage(  .templates(  .undo(  .ack(  .saveDraft  .loadDraft      → 全部 0 次
resolveShortcut：仅定义处 1 次（没有任何 window.addEventListener 用它）
```

对应的模块也都在，但没人 import：

| 模块 | 内容 | 被引用 |
| --- | --- | --- |
| `drafts.ts` | 草稿保存（防丢东西） | ❌ |
| `shortcuts.ts` | Ctrl+K / Ctrl+N / Ctrl+, / Ctrl+B / Ctrl+1..9 / Esc | ❌ |
| `metrics.ts` | 状态栏指标 | ❌ |
| `sidebarWidth.ts` | 侧栏拖拽 | ❌（新界面无侧栏） |
| `iconTheme.ts` | 图标主题 | ❌ |

### 1.3 状态流上的三个硬漏洞

| 漏洞 | 代码位置 | 用户看到的后果 |
| --- | --- | --- |
| **别的项目的进度全部被吞** | `state.ts:76,85,93,100` 每个 case 都有 `if (event.projectId !== state.currentProjectId) return next;` | 你在 A 项目，B 项目的执行者跑完/卡住，**界面上一点反应都没有**。多项目是卖点，但界面对其它项目是瞎的 |
| **没有"正在思考"的指示** | `state.ts` 有 `thinking` 字段，`Composer` 不读 | 发出消息后到 C 回第一段之间，界面完全静止；用户会怀疑没发出去 |
| **发送失败静默** | `App.tsx:113` `catch {}` | 乐观消息留在屏幕上，看起来像发出去了，实际没发 |

### 1.4 构建产物确认（用户装的版本就是这个）

`apps/web/dist/assets/index-8SNDvZuV.js` 全文搜索：

| 字符串 | 命中 |
| --- | --- |
| `待审批` | 0 |
| `批准执行` | 0 |
| `命令面板` | 0 |
| `@ 引用` | 0 |
| `批次` | 0 |
| `执行轨迹` | 1（内容是「完整执行轨迹待实现」） |

即：**v0.105.2 的安装包里，审批、命令面板、附件、@、批次线、轨迹，一个都没有。**

### 1.5 测试这一层的真相

- `pnpm --filter @opencoxswain/web test` **失败**（`ENOENT ... src/components/AppIcon.tsx`）。
  它跑的是 `dist-test/` 里 11-14 的**旧构建**，新界面没有任何测试。
- `apps/web/src` 下**零个测试文件**。
- 结论：`next-steps.md`、`project-status.md` 里「测试 698 条（运行时 584 + 界面 259）」这个数字**不适用于当前界面**。
  这是文档层面的易用性问题——它让"已完成"变得不可信，而 `ui-spec.md` 第 227 行记过同一类教训。

### 1.6 运行时早就有、界面没用的接口

`server.ts` 已实现，但新界面从不调用：

| 接口 | 能力 | 现状 |
| --- | --- | --- |
| `GET/POST /api/approvals/:id/approve\|reject` | 危险动作批准/拒绝（带理由） | 只到 DB，界面无入口 |
| `POST /api/projects/:id/stop` | 停止 | **已级联**（见下）；界面已接「停止全部」 |
| `POST /api/executors/:id/cancel` | 取消单个 Agent | 界面无按钮 |
| `GET /api/search` | 会话全文搜索 | 无入口 |
| `GET /api/insights/usage` | 用量 + 止损线 | 无入口 |
| `GET/post /api/templates` | 五类任务模板 | 无入口 |
| `POST /api/side-effects/:id/undo` | 撤销写文件 | 无入口 |
| `GET /api/executors/:id/checkpoints` + `/rollback` | 检查点回滚 | 无入口 |
| `POST /api/reports/:id/ack` | 待决策"已看过" | 无入口 |
| `GET /api/projects/:id/files` | `@` 引用用的文件树 | 无入口 |
| `GET /api/permissions`、`/api/models`、`/api/settings` | 权限档位 / 模型 / 密钥 | 无入口 |

**这十行是本文档的全部机会来源：能力都在，只差界面。**

### 1.7 一个真实的界面（截图，mock 数据）

`node scripts/shot-new-ui-busy.mjs`（1440×900，模拟 2 个在跑 + 2 个完成 + 1 个待拍板）：
产物在 `.ui-shots/ux-audit/new-02-busy.png`。

看图能立刻读出的问题：

| 现象 | 为什么是问题 |
| --- | --- |
| 待拍板卡片只有「查看并处理 / 看执行过程」两个按钮，**回答框在屏幕左边最底下，离卡片 700px** | 上下文断裂：读问题和回答问题隔着一整块屏幕 |
| 已完成的「补充组件测试 / 更新 README」和正在跑的「导出排障」**长得一样**，只差颜色和一行小字 | 用户要先读字才能知道谁在动（对照 §2.4 K：行上要有在跑/等你/结束三态） |
| 输入框上方**没有"谁在跑"** | 用户在对话区时对右栏一无所知（§2.2） |
| 整屏**没有任何数字**（token、耗时汇总、用量上限） | 同类产品的共识是"把表摆在输入框旁边"（§2.2、§2.10） |

---

## 2. 同类产品怎么做（按操作归类，附可核对的机制）

> 来源全部是官方文档、官方仓库源码或可核对的 issue。未能核实的项在末尾 §7 单独列出。

### 2.1 危险动作确认——"要不要问人"，业界已经换成按风险分级

| 产品 | 机制（原文机制名） | 关键数字/标签 |
| --- | --- | --- |
| **Cursor** | Settings → Agents → **Approvals & Execution** 三档：**Auto-review**（先查 allowlist → 再进沙箱 → 再交给 LLM 分类器）/ **Allowlist** / **Run Everything**。规则写在 `.cursor/permissions.json`，是**大白话**（`allow_instructions` / `block_instructions`），可以让 agent 自己帮你写 | 分类器用的是 Gemini 3.5 Flash Lite；官方明说 **"is not a security boundary"** |
| **Claude Code** | 6 种 permission mode；默认自 v2.1.283 起是 **`auto`**（由分类模型判）。确认框选项随情境变化：**Yes / Yes, and don't ask again for `<X>` / Yes, and switch to auto mode / No**；在 Yes/No 上按 **Tab** 可以附一句理由 | "don't ask again" 对 Bash **永久生效且按仓库+命令记录**，写进 `.claude/settings.local.json` |
| **Codex CLI** | 两个正交轴：`approval_policy`（untrusted / on-request / never）× `sandbox_mode`（read-only / workspace-write / danger-full-access）；`--full-auto` = workspace-write + on-request | 未受信任目录**先降为只读**，等你点 "Trust this directory" |
| **Copilot** | 三层：**Manual（默认）/ Assisted（LLM judge）/ Allow all**；cloud agent 的每个改动附**置信度 high/medium/low**，仓库可设 automation level（Full control / **Cautious 默认** / Balanced / Full automation），低于阈值的改动**只作为建议挂着**等你批 | 官方提醒：**"Approvals are a workflow convenience, not a security control"** |
| **Kiro** | 能力维度权限：`fs_read` / `fs_write` / `shell` / `mcp` / `sandbox_network`…；效果四种 **`deny` > `ask` > `allow` > `evaluate`**，支持 exclude glob | `evaluate` 被明文标注为**最弱的一种效果** |
| **TRAE** | 三档：**手动审批 / 自动审批（内置 LLM Guardian 判） / 完全访问（沙箱关闭）** | 删除默认进**回收站**而不是直接删 |
| **Gemini CLI** | 策略引擎 TOML：`allow` / `deny` / `ask_user`，按 `commandPrefix` / `commandRegex` 匹配，`denyMessage` 解释为什么拒绝 | 全局 deny 会把工具**从模型记忆里移除** |
| **Amp** | **默认不问**；如果要管，写插件（TypeScript）用 `amp.on(...)` + `ctx.ui.confirm` | 把审批做成"策略即代码" |

**我们能直接照抄的两条**

1. **按动作分级，不要按会话分级。** 我们只有四档全局开关，切到 `auto` 就连 `git push` 一起放行。
   正确形状：低风险自动、高风险逐个问、少数永远不允许——**并且每次批准可以顺手变成一条规则**（"以后 `git status` 不用问"，"以后 `rm` 一律问"）。
   我们的 `classify.ts` 已经能分类成 `delete/push/publish/pay/external_send`，`approval.ts` 的 `actionKey()` 已经是天然的规则键。**缺的只是让它可持久化、可编辑。**
2. **确认框里要给出"会发生什么"。** 全市场**没有一个**产品在做**改动爆炸半径预估**（几个文件、哪个目录、会不会碰网络），
   代价是 Codex 的 issue #59060（**3,491 👍**）：agent 把 systemd 和容器一起毁了。
   我们有 `sandbox.ts` 的路径分析、`diff.ts` 的改动统计、`ledger.ts` 的落账——**拼一下就能在确认框里写"将删除 3 个文件（均在 src/legacy/），不影响 12 个被引用的模块"**。

### 2.2 长时间运行的可见性——"它现在在干什么"

| 产品 | 做法 | 细节 |
| --- | --- | --- |
| **Copilot / Codex** | session log 实时滚 + **token 用量 + 会话时长** | 官方用"日志 + 步级推理 + 用量"替代进度条 |
| **Gemini CLI** | agent 自己维护 **`write_todos`**，活动项标 `[IN_PROGRESS]` 显示在输入框上方；`Ctrl+T` 看全量 | 有明确的"下一个动作" |
| **TRAE** | **任务摘要**面板显示 Todos + **本回合引用的上下文**，底部显示**上下文占用 %**，旁边一个 **压缩**按钮 | 上下文快满时用户能自己压 |
| **Cursor** | Cloud agent 产出 **artifacts：截图 / 录屏 / 日志**，可嵌进 PR | "看到它怎么验的"，而非"它说验过了" |
| **Claude Code** | 可定制的 **status line**（`/statusline`，用自然语言生成）+ `Ctrl+T` 任务清单（最多 5 条）+ `/context` 彩色网格 + `/usage` | |
| **Cline（TUI）** | 状态区同时显示：模型、上下文用量、花费、分支、diff 统计、Plan/Act、自动批准状态 | 默认底栏信息最全 |

**行业共识：没有人做"百分比进度条"**，因为模型自己也不知道还剩多少——这与我们 `RunnerLane.tsx` 的注释（"不画进度百分比"）**结论一致，做法也对**。
但业界补的是另外几样：**它下一步要做什么**、**它已经动了哪些文件**、**上下文/用量还剩多少**。
我们三样都没有。

**我们独有的优势反而没露出来**：`metrics` 里有 `turns / steps / tokensIn / tokensOut / modelMs / contextTokens`，
`RunMetricsDto` 甚至算好了吞吐和缓存命中——**界面上一个字都不显示**。

### 2.3 打断与追加——发出去的活儿还能不能纠偏

> **先分清两件事，我们这里和业界不一样，而且是故意的：**
>
> | | 业界做法 | 我们 |
> | --- | --- | --- |
> | **打断 Assistant** | 都在做（排队 / 插话 / 停止） | **刻意不做。** 用户不需要打断 Assistant，只说最新的想法，消息排队等当前这轮跑完再被看到 |
> | **叫停** | 停止 / Esc | 必须**级联**：Assistant 停了，它派出去的 Agent 也要全部停下 |
>
> 另外，"排队"只形容**消息**。**任务本身不排队**：C 派出的 D 可以并行（只读零排队、写按写域互斥），
> 且 C 会持续盯着每个 D 的结算往下推进。跨轮次“一路做到完”缺的是**方案（Plan）这个承载物**，
> 见 [`plan-approval.md`](plan-approval.md)。
>
> 这不是缺点，是产品设计。**但它带来一个必须补上的责任**：一旦"打断"这个动作从界面上消失了，
> 用户唯一能表达"别干了"的途径就是"停止"——那么"停止"就必须真的把一切停下来，而且**界面要说得清楚**。

| 产品 | 打断机制 |
| --- | --- |
| **Copilot（VS Code）** | 运行中输入框的发送键变成三选一下拉：**Add to Queue**（当前回复结束后发）/ **Steer with Message**（**当前这一步工具执行完**就让道）/ **Stop and Send**（直接取消） |
| **Claude Code** | 运行中 **Enter = 排队**（灰色显示），**Ctrl+Enter = 立刻插队**，输入框为空时按 **↑** 把队列里的拿回来改 |
| **Codex CLI** | **Enter = 插话**，**Tab = 排队**，**Ctrl+Enter = 打断并发送** |
| **Windsurf** | 运行中 **Enter 入队**，空输入框再按 **Enter = 立即发** |
| **Devin / TRAE** | **只读侧边对话**（`/btw`、侧边对话）：可以问、不能改文件，所以**不会污染主流程** |
| **TRAE** | **回退消息**：任务完成后可以把对话和相关文件变更退回到某条消息之前；执行中必须先点停止 |

**我们的推理链本来是对的，但断在了最后一环。** 既然不提供"打断 Assistant"，`/stop` 就必须是"停掉这一切"。
它需要的级联语义是：Assistant 这一轮停掉 + 在跑的 Agent 全取消 + **排队的 Agent 也取消**
（否则上限一释放，它们会自己开跑——用户叫停后又被自己叫停前派出去的活接着干，比不停更让人意外）。

**而实际发生过的事**：`POST /api/projects/:id/stop` 只调了 `assistant.stop()`，**一个 Agent 都没停**；
界面上还根本没有这个按钮。用户以为停了，Agent 还在改文件、还在烧 token——这是最坏的一种静默失败。

这一条已修，见 §1.6 与 §5 第 4 条。

### 2.4 多执行者——"现在谁需要我"

这是全市场的共同难题，也是我们产品形态最该赢的地方。

| 产品 | 做法 | 用户原话证据 |
| --- | --- | --- |
| **Multica** | **Inbox**：同一 issue 的多条通知合并成一条；**"Mark as unread" = 我看了但没处理完**；Runs 与 Issue 分离，运行态里有 `waiting_local_directory`（等目录锁释放）这种诚实状态 | |
| **vibe-kanban**（已停运，但设计清楚） | **"Needs Attention"** 桶：有未读活动的 workspace；一个 task 可有 **多次 attempts**（换 agent / 换分支 / 全新上下文 = best-of-N） | |
| **Cursor 3** | Agents Window 侧栏列全部 agent（本地/云端/worktree/SSH/mobile 发起的），3.1 起可**平铺分格** | 但用户投诉**焦点被抢**："我在 5 个并发 agent、100+ 文件改动时，它会跳到我正在读的地方"（官方承认在跟） |
| **TRAE 宝** | 任务先汇总到项目助理，再出"需要关注的问题、待定事项、交付产物"卡片 | **用户点名要的东西**：「每行自己带一句这活在做什么，再加三个状态：**在跑、等你回复、结束**」 |
| **Claude Code** | 会话按状态组织（needs you / working / done）；另有 **session recap**：离开 ≥3 分钟回来，给一行 ≤400 字的摘要 | |
| **Codex / Amp / Kiro / TRAE mobile** | 手机当收件箱：完成/需要你 时推送；Kiro 手机端每个改动文件是一张**手机尺寸的 diff 卡** | |

**同一个诉求被两个不相干产品的用户独立提出来**（Cursor 和 TRAE 宝），说明这是结构性的：
> **一行 = 名字 + 一句"它在干什么" + 三个状态（在跑 / 等你 / 结束）。**

我们的跑道离这个还差三点：`RunnerLane` 有 `label` 和 `status` 点，但
① 已完成的收成细线后**和进行中同形**；② 没有"等你"的独立视觉（靠 `blockedReason` 推断）；
③ 换项目时**全部消失**（§1.3）。

### 2.5 审阅自己的活儿——怎么不靠"它说完成就算完成"

| 产品 | 做法 |
| --- | --- |
| **Copilot** | cloud agent 每改动附**置信度**；**"rubber duck" 审查 agent 单独跑在另一个模型上**（"评审者更不容易有同样的盲区"） |
| **Cursor** | 专门的 **verification agent**（原文：*"addresses a common issue where AI marks tasks done but implementations are incomplete or broken"*）；另有 Agent Review（**Quick = 低成本 / Deep = 高成本**，明确标价格档位） |
| **Devin** | 完成后先发**测试计划**给你改，再执行，然后**带标注的录屏**（自动放大）附在 PR 上 |
| **Codex** | review 面板三级：**整个 diff / 按文件 / 按 hunk** 都能 stage / unstage / revert |
| **Kiro / Cursor / Windsurf** | 三个不同的"撤回"：文件快照回滚、**对话分叉**、git |

**我们有独特优势，但界面把优势做成了死角。**
`acceptance/verify.ts` 是"系统独立重跑命令、不采信 Agent 自述"，`verdict` 三值（passed / failed / unverified）。
调研里 41% 的开发者"经常遇到 agent 声称完成但其实是坏的"——**我们的机制正好治这个病**。
但 `ExecutorFocus.tsx` 把验收渲染成一个没有颜色的 `<ul>`，而且写在最底下、字号比正文小，
用户要滚到"完整执行轨迹待实现"上面一行才看得到。

### 2.6 Diff 与撤销——改了什么、能不能退

- **行业标准已经退步了一次**：Codex/Copilot 能做按 hunk 的接受/拒绝，**Cursor 的 Agents Window 反而把这功能做没了**，官方原话是"这是最被需要的功能之一"。
  教训很清楚：**把人从"接受 agent 的编辑"换成"审 diff"时，必须同时给出按块粒度，否则老用户会反弹。**
- **Claude Code 的 `/rewind`（Esc Esc）有三个明确的洞**（官方承认）：**不跟踪 bash 改的文件**（`rm` / `mv` / `sed -i`）、不恢复子 agent 的编辑、跳过软链接。
  也就是说：**所有产品的撤销都不是靠"快照对话"，而是靠"文件和命令的双轨记录"。**
- **我们恰好有更好的底子**：`security/snapshot.ts` + `ledger.ts`（执行前落 pending）+ `checkpoint.ts` + `undo.ts`，
  而且是**唯一按"不可逆动作"识别命令的**（`classify.ts` 连 `echo x > file` 都认）。

问题只有一个：**界面上没有一个"撤销"按钮。** `docs/undo.md` 第七节写的六条验收标准，今天一条都没实现。

### 2.7 并行与隔离

- **worktree per agent 是事实标准**：Cursor `/best-of-n`（每个候选一个 worktree，默认上限 25）、vibe-kanban `vk/<id>` 分支 + 冲突对话框带 **Abort**、Copilot 隔离下拉（Branch / New Worktree）、TRAE 工作树 + **AI 合并**。
- **但所有产品都诚实地说 worktree 不是安全边界**：Copilot 原文 *"Worktrees isolate working files, not the agent's access to your machine"*。
- **并发上限有经验值**：3–5 个是能"真的审得过来"的量（Addy Osmani，Claude Code 团队）；AWS 的表述更狠——*"那时人不再是审阅者，变成了队列"*。

我们的 `orchestrator/decisionRules.ts` 内核里有 `limit (默认 5)`、写域互斥、只读任务不排队——
**这一层其实比多数产品做得细**。问题同样在界面：队列在排队、谁被谁挡住，用户看不见。

### 2.8 上下文与输入

| 能力 | 业界 | 我们 |
| --- | --- | --- |
| `@` 文件引用 | 全部都有（OpenCode 还支持 `@src/auth.ts#20-45` 行区间） | 运行时已备好 `/files` 接口，界面无 |
| 贴图 | Claude Code `Ctrl+V` → `[Image #N]` 芯片；OpenCode 20MiB/项 | legacy `attachments.ts` + `multimodal.test.ts` 都在 |
| 拖文件 | 全部 | 同上，界面无 |
| 斜杠命令 | `/` 弹菜单，且**高亮规则很讲究**（打字 `/adddir` 会高亮 `/add-dir`；打错则什么都不亮） | 我们连 `/` 都输入不进去（没有命令面） |
| 项目规则文件 | `AGENTS.md` / `CLAUDE.md` + `/init` 一条命令生成 | 我们有 `.opencoxswain/rules.md` + 记忆，**但用户不知道怎么开始** |
| 上下文快满 | TRAE 每回合显示 % + 压缩按钮；Claude `/context`；Windsurf 上下文条 | `contextTokens` 在数据里，界面无 |

### 2.9 错误、重试与恢复

| 场景 | 业界做法 |
| --- | --- |
| 模型重试 | Claude Code 直接显示 **`Retrying in 15s · attempt 2/10`**，从第 3 次起显示**具体原因**而不是 `API error` |
| 答错了 | Devin Desktop "Duplicate session"、TRAE "创建会话副本"、Kiro **Rewind = 分叉对话**（不动文件） |
| 用法超限 | Claude Code **超限重置后自动继续** |
| 静默失败 | Jules 是最惨的反面教材：计划没人批，**服务端约 7 分钟后静默判 `COMPLETED`（无 PR），不可恢复** |

我们：`App.tsx:113` 的 `catch {}` 是**最小的那一类错误**——网络失败不告诉人。
更大的问题是**CLI 里有的状态（重试中、限流中）根本没进 SSE**，界面上看不到。

### 2.10 首次使用与入门

| 产品 | 前 5 分钟 |
| --- | --- |
| vibe-kanban | `npx vibe-kanban` 一条命令，文档里 7 步走到"建 issue → 看 diff" |
| Claude Code | `/login` → `cd 项目` → `claude` → `/init`（官方说这是"价值最高的一步设置"）→ 首次 diff 时问 Yes/don't ask again/No |
| Gemini CLI | 登 Google → **文件夹信任对话框** → `/init` 生成 GEMINI.md |
| Codex app | **内置三个示例任务**，其中"Snake"那条是一份带 Scope & constraints / Implementation plan / Deliverables 的完整示范——**用示例教你把话说清楚** |
| Cursor 3 | ❌ 反面案例：125 楼的长帖都在问"菜单项在哪"，官方回复"说明确实需要改进" |

我们的首次路径（按代码）：
`App.tsx` 首屏 → 没项目 → "还没有打开项目 / 打开一个工作目录就可以直接对它说你要做什么" → **但界面上没有"打开项目"的按钮**，
也没有填 API Key 的入口（`/api/settings` 未接）。也就是说：**全新安装的用户第一步就走不下去。**

### 2.11 成本与用量

| 产品 | 做法 |
| --- | --- |
| Devin | 会话结尾给 **Session Insights 档位 XS/S/M/L/XL**，L/XL 直接**标成不健康**；空闲 5 分钟自动睡眠不计费 |
| Multica | 每个 run 记 **Spent / Tokens / Agent 时间**，可按 agent、按模型拆 |
| Cursor | 首次用 Cloud agent 就**要求设花费上限** |
| TRAE | 用户自己建的定时任务按分钟烧积分，被吐槽到停任务——**能看见数字才管得住** |

我们有 `insights/usage.ts` + `cost/budget.ts`（单任务/每日 token 上限，超了**真停**）——这在同类里是少见的硬止损。
但界面上**一个数字都没显示**，用户只能在账单里发现。

### 2.12 执行轨迹

Claude Code 的 `/diff` 是**带作用域的全屏面板**（`T1/T2…` 每回合、`Current`、Ctrl+X B 切换比较基准）；
Codex 有 `Ctrl+T` 轨迹与 transcript 面板；Devin 的 **Progress 页把 shell 命令、代码编辑、浏览器活动汇总成一条统一时间线**，还能点单个步骤看详情；
Kiro CLI 允许 `/settings` 调"工具调用显示多细：一行到全量"。

我们的 `web-legacy/TraceView.tsx` 已经有：统计头、搜索、筛选（全部/失败/写操作）、时间轴、可展开明细——
**这正是行业在做的形状**，但目前不在 `apps/web` 里，新界面写的是「完整执行轨迹待实现」。

---

## 3. 逐项对比表

图例：✅ 有且好用 · ⚠️ 有但不完整 · ❌ 没有 · `(legacy)` = 旧界面有、新界面没有

| 操作 | Cursor | Claude Code | Codex | Gemini CLI | Copilot | TRAE / 宝 | Kiro | Multica / vibe-kanban | **我们（新界面）** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 打开项目 / 首次配置 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 没有入口 |
| 危险动作**按动作**确认 | ✅ 三档 + 大白话规则 | ✅ 6 模式 + don't ask again | ✅ 双轴 | ✅ TOML 策略 | ✅ 三档 + 置信度 | ✅ 三档 | ✅ 能力×效果 | — | ❌ 只有全局四档 |
| "以后都别问" | ✅ | ✅ 按仓库+命令持久化 | ✅ execpolicy | ✅ | ✅ | ⚠️ | ✅ | — | ❌ |
| 拒绝时带理由回灌模型 | ⚠️ | ✅ Tab 附注 | ✅ deny-with-guidance | ⚠️ | ⚠️ | — | ✅ | — | ⚠️ 有字段，无输入框 |
| 计划先批后做 | ✅ Plan Mode | ✅ `/plan` + 三选项 | ✅ `/plan` | ✅ 默认开 | ✅ Plan mode | ✅ `/Plan` `/Spec` | ✅ 逐阶段 Review | — | ❌ |
| 停止 | ✅ | ✅ Esc | ✅ Esc | ✅ | ✅ | ✅ 侧边对话 | ✅ | ✅ | ✅ **已修：级联取消在跑+排队** |
| 运行中追加指令 | ✅ 排队/插话 | ✅ Enter 排队 / Ctrl+Enter 插队 | ✅ Enter 插话 / Tab 排队 | ✅ Tab 排队 | ✅ 三选一 | ✅ 侧边对话 | ✅ | ✅ | ⚠️ 只排队（**故意的**），但已加提示 |
| 回答待决策 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 卡片 | ✅ | ✅ | ❌ 按钮不通 |
| "谁在等我"的路由 | ⚠️ 侧栏 | ✅ 按状态分组 + recap | ✅ | ✅ OSC9 通知 | ✅ | ⚠️（用户点名要） | ✅ 手机 | ✅ Needs Attention / Inbox | ⚠️ 只在当前项目 |
| 进度有真实指标 | ✅ 步骤+用量 | ✅ status line + `/context` | ✅ `/status` | ✅ todo + `/stats` | ✅ log+用量 | ✅ 上下文% + 压缩 | ✅ waves | ✅ Spent/Tokens | ❌ 有数据不显示 |
| 看 diff | ✅ | ✅ `/diff` 面板 | ✅ 三级 stage | ⚠️ | ✅ Keep/Undo | ✅ 代码变更页 | ✅ | ✅ 侧栏 diff | ❌ |
| 撤销 | ✅ checkpoint | ✅ `/rewind`（有明确的洞） | ❌ | ✅ `/rewind`+`/restore` | ✅ working set Undo | ✅ 回退消息 | ✅ Revert | ✅ Abort | ❌ 有接口无按钮 |
| 验收/证据 | ✅ artifacts | ⚠️ | ✅ 测试输出 | ⚠️ | ✅ 置信度+rubber duck | ✅ 审查+流程图 | ✅ 属性测试 | — | ✅ 机制独有，⚠️ 展示弱 |
| `@` 文件 / 贴图 / 拖入 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌（legacy 有） |
| 会话搜索 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ 有接口无入口 |
| 命令面板 / 快捷键 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌（`shortcuts.ts` 写了没用） |
| 用量/花费可见 | ✅ 上限+计量 | ✅ `/usage` | ✅ rate limit | ✅ `/stats` | ✅ | ⚠️ | ✅ 倍率 | ✅ 按 run 拆 | ❌ 有上限无显示 |
| 模板 / 示例任务 | ⚠️ | ✅ `/powerup` | ✅ 三个示例 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌（`templates` 接口在） |
| 通知 | ✅ iOS 灵动岛 | ⚠️ | ✅ 手机 | ✅ OSC9+响铃 | ✅ | ✅ 手机 | ✅ 手机 | ✅ 声音+推送 | ❌ |

**读表的方法**：机制那一列我们打了很多 ✅，交互那一列几乎全是 ❌。
这不是"能力差距"，是"**能力没接出来**"——所以修复主要是**接线与排布**，不是再造轮子。

---

## 4. 他们被骂得最狠的地方 = 我们的机会

调研里最有分量的一组数据来自 2026-11 的一项 **203 人问卷**（[arXiv:2611.10058](https://arxiv.org/abs/2611.10058)，用户中位使用 12 个月；91% 在同时用 ≥2 个 agent）：

| 事实 | 数字 |
| --- | --- |
| 至少有一种动作**没细看就点了同意** | **64%** |
| 其中"删除/提权命令"没细看就同意 | 26% |
| 认真逐行审代码的人，同样会草率批动作 | 61% vs 67%，**无显著差异** |
| 自主权越高，**审核越松** | 77 组里 48 组如此；补偿性护栏 110 组里**零**显著 |
| **知道真实安全事故**的人，反而更草率 | 70% vs 43%，OR 2.58 |
| 会记日志/审计动作的人 | **仅 20%** |
| 常遇到"说完成了其实是坏的" | **41%** |
| 觉得"跨文件/跨会话/跨 agent 追变更"很吃脑力 | **58%** |
| 觉得"审批打断"很吃脑力 | **49%** |
| 想要更多自主权的前提（自由作答里） | **bounded 34% / observable 35% / reversible 19%** |

作者给产品方的四条设计含义（原文 D1–D4）：
**D1 开工前确认意图与范围**（不只是执行中逐个批动作）；**D2 权限按动作风险分级**；**D3 预览动作会改什么，并留一份跟 diff 一样容易看的记录**；**D4 代码和非代码动作都要有检查点和回滚**。

补充数据：[Stack Overflow 2025](https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/)（4.9 万开发者）信任度 **40% → 29%**，第一大痛点 **45% 是"几乎对但不完全对"**；
[DORA 2026](https://dora.dev/insights/balancing-ai-tensions/) 把"省下的写作时间重新花在审计上"叫 **verification tax**，并指出真正上升的是**审阅者的认知负荷**。

**这四条几乎正好落在我们已有的机制上**：`classify.ts`（D2 的分级基础）、`ledger.ts`（D3 的可审计记录）、
`snapshot/checkpoint/undo`（D4）、`decisionRules.ts`（D1 的"只问该问的"）。
**我们和"该做成什么样"之间的距离，比多数产品都近——唯一的问题是没有把这些露给用户。**

两个反面教材值得记住：

- **vibe-kanban 关了**（2026-04-10，[公告](https://vibekanban.com/blog/shutdown)）：数千人每天用，但"绝大多数是免费用户，找不到商业模式"。
  它证明了**注意力路由这一层自己卖不出钱**，价值落在 agent 和模型上。对我们这种"自己用"的产品，结论是：**把这一层做薄做对，别做成一个看板产品**。
- **Jules 的 7 分钟静默死亡**：计划没批 → 服务端静默 `COMPLETED`（无 PR）→ 不可恢复。
  **任何"等我在浏览器里点一下"的设计，都必须有超时后的显式路径**——我们 `approval.ts` 的 10 分钟自动拒绝方向是对的，
  但超时后界面上什么都不发生，等于同样的病。

---

## 5. 优化清单（按"用户当天能感觉到"排序）

> 每条都给了验收标准。**没有一条需要新造机制**——全部是把已有的东西接上或摆对。

### 第一档：不做就没法用（P0）

#### 1. 待拍板要能**当场拍板** ——「查看并处理」必须通向一个能回答的地方

- **现状**：`RunnerPanel.onDecide = openExecutor`，详情页没有输入框。
- **要做**：待拍板卡片里**直接**给一个输入框 + 两个动作（**「按这个继续」/「先别动」**），
  并把该执行者的**最近 3 步和具体问题原文**贴在卡片里。点「看细节」才进详情页。
- **对标**：Copilot 的 approvals panel（Accept / Accept all / Decline per suggestion）、TRAE 宝的"卡片让你确认"。
- **验收**：从看到卡片到发出决定 ≤ 2 次点击、0 次滚动；决定发出后卡片变成"已答复，等 Agent 下一步"。

#### 2. 恢复"打开项目 / 设置密钥"入口

- **现状**：空项目态只有两行字，`/api/settings`、`/api/models`、`/api/projects`(POST) 都未接。
- **要做**：空态直接给「打开文件夹」「填写模型密钥」两个按钮；密钥填错时明确说错在哪。
- **对标**：Claude Code `/login` 之后的 `/init` 一步；Gemini 的"文件夹信任"对话框；Codex 的示例任务。
- **验收**：全新安装 → 双击 → 说出第一句话 → 看到 Agent 开始干活，**全程不离开窗口**。
  这也直接回应 `competitor-verdict.md` §5.3 提到的"没有一个外部用户能照着跑通的路径"。

#### 3. 审批要露出来，并且可以"顺手立规矩"

- **现状**：审批只到数据库。用户唯一感知是执行者莫名卡住。
- **要做**：
  ① 顶部一条**待审批横幅**：「3 个动作等你批准 · **未批准前不会执行**」（legacy `ApprovalPanel` 原文就写了这句，照抄）；
  ② 每条写清 **谁要干什么 / 会改到哪些文件或目录 / 为什么危险 / 还剩几分钟自动拒绝**；
  ③ 三个按钮：**批准 / 拒绝（可写理由，理由会回灌给模型）/ 批准并记住这条规则**；
  ④ 规则存成 `(tool, 命令前缀)` 的白名单与黑名单，**可在界面上查看和删除**。
- **对标**：Claude Code 「Yes, and don't ask again for `git status`」+ `.claude/settings.local.json`；
  Codex 的 `approve_for_prefix`；Cursor 的 `permissions.json` 大白话规则。
- **为什么优先**：§4 的数据说明"全局开关 → 要么烦到关掉、要么放到不审"是必然结局；规则化是唯一的出路。
- **验收**：`approval.test.ts` 之外新增：同一条 `git status` 批准一次后不再弹；`git push` 仍然弹；规则能在界面上删掉。

#### 4. 停止：**已经修好一半** —— 级联语义补上了，界面按钮接上了

- **原缺陷**：`POST /stop` 只调 `assistant.stop()`，一个 Agent 都不停；界面也没有按钮。
- **已做**（`orchestrator.stopAll()`）：
  ① 先停 Assistant（否则它这一轮可能继续 spawn 新 Agent）；
  ② 项目内**所有非终态**的 Agent 逐个走 `cancel()`——中止、结算、释放写域闸门，状态记 `cancelled` 而**不是** `done`；
  ③ **排队中的也取消**，否则上限一释放它们会自己开跑；
  ④ 返回 `cancelledExecutors` / `failedExecutors` 两个数，界面据此说"停了 N 个"而不是含糊的"已停止"；
  ⑤ 界面接入「停止全部」，并在旁边常驻一句 **"N 个 Agent 在跑 · 直接说新的想法，它们不会被这句话打断"**——
     把"连发不打断"这个**故意设计**讲给用户听，否则用户会以为说话没反应。
- **测试**：`apps/runtime/src/test/stopAll.test.ts` 两条——在跑的全部变 `cancelled` 且不得是 `done`；排队的也取消。
  全量运行时回归 843 条全部通过。
- **还要做的**：
  - 如果这次是**局部**收手（只想停某一个），需要跑道条上的单条取消（`/api/executors/:id/cancel` 已实现，界面未接）；
  - 停止后 C 应主动说一句"已停 N 个，其余保持原状"——现在停完是一段沉默。
- **验收**：点「停止全部」后 2 秒内所有跑道变灰并显示"已取消"；**没有**任何 Agent 继续产出；`stopAll.test.ts` 通过。

#### 5. 别的项目不能是瞎的

- **现状**：`state.ts` 里所有非当前项目的事件直接丢弃。
- **要做**：项目下拉里每个项目带 **`●2` 在跑 / `⚠1` 等你** 的徽章（`ProjectDto` 已有 `running` 和 `needsUser` 字段，只是没人渲染）；
  其它项目出现"需要你"时，在**当前项目**顶部出现一条可跳转的提示。
- **对标**：Multica 的 Inbox 合并、`Needs Attention` 桶、Claude Code 的 needs-you 分组。
- **验收**：在 A 项目里说话，B 项目的 Agent 卡住 → A 项目顶部出现"B 项目有 1 件等你的事"，点一下跳过去。

### 第二档：每天都在用（P1）

#### 6. 执行轨迹：用回 legacy 那份

`web-legacy/TraceView.tsx`（统计头 + 搜索 + 筛选 + 时间轴 + 可展开明细）直接迁进 `apps/web`，
并把 `ExecutorFocus` 里的「完整执行轨迹待实现」删掉。
按 hunk 的 diff 视图可以后做，但**"它到底跑了哪些命令"必须能看**——这对应 §4 里"只有 20% 的人会审计"的正解。

#### 7. 撤销与检查点按钮

`/side-effects/:id/undo` 和 `/executors/:id/checkpoints/:id/rollback` 接到轨迹页每一行旁边，
不可逆动作**明确标"不可撤销"**（`docs/undo.md` §4 已经写了这条边界，照做即可）。
这条直接满足 arXiv 的 **D4**，也是用户原话里排第三的"想要可逆"（19%）。

#### 8. 把指标摆到输入框旁边

状态栏显示：**在跑 N · 等你 M · 今日 token / 上限 · 当前上下文占用 %**。
数据全都有（`metrics.ts` 现成）。上下文超过 80% 时变色，并给一个「压缩」入口（`session/compact.ts` 在）。
对标 TRAE 每回合的上下文 % + 压缩按钮。**不做百分比进度——这一点我们的判断是对的，保持。**

#### 9. 命令面板与快捷键接上

`shortcuts.ts` 已经在仓库里写好且带注释，缺的只是一次 `window.addEventListener('keydown', ...)` 和一个 `CommandPalette`。
「所有入口都能被 Ctrl+K 找到」是 `ui-redesign-spec.md` 第 7 节已经写下的验收标准，今天没有实现。
**同时**把 `/api/search` 接进去（会话全文搜索）。

#### 10. 轨道条的"三态"

按 TRAE 宝用户的原话改：每行 = 名字 + 一句"在干什么" + **在跑 / 等你 / 结束**。
已完成的不要只收成细线，而是收成"**结束**"态并保留结论首句。
待拍板的跑道要有独立的、一眼可辨的形状（不是只换个颜色）。

#### 11. 输入侧的"告诉它看什么"

附件（拖入 / 粘贴 / 选择，legacy `attachments.ts` 整套都在）、`@` 文件引用（`/files` 接口在）、
任务模板（`/templates` 在，五个：修缺陷 / 加功能 / 写文档 / 重构 / 调研——**首次使用的最佳内容**）。

### 第三档：用了会喜欢（P2）

| # | 项 | 对标 |
| --- | --- | --- |
| 12 | 会话草稿（`drafts.ts` 已写好，接上即可） | 全行业 |
| 13 | 消息级操作：复制 / 编辑重发 / 从这个点分叉对话 | Kiro Rewind、TRAE 创建会话副本 |
| 14 | 桌面通知：**只在"等你"和"结束"时发** | Gemini OSC9 只报 Action required / Session complete；GitHub 上明确有人要求"别推进度，只推要我处理的" |
| 15 | 离开 ≥3 分钟回来给一行摘要 | Claude Code session recap |
| 16 | 首屏空态给三个可直接点的示例（含一条完整的"把话说清"的示范） | Codex app 的 Snake 示例 |
| 17 | 验收结果改成**主色芯片 + 一句话结论**（现在是无色的 `<ul>`） | Copilot 置信度、Cursor Agent Review 的 Quick/Deep |
| 18 | 会话用量档位（XS–XL），L/XL 标"不健康" | Devin Session Insights |
| 19 | **方案审批关卡 + 批准后自动推进到完**（含小改动报不停、大改动停并重批、按写域只停冲突者） | Claude Code `/plan`、Kiro Specs、TRAE `/Plan` `/Spec`。**详细设计见 [plan-approval.md](plan-approval.md)**。这一条是本产品的主线，优先级应高于本文其它 P2 项 |

---

## 6. 值得保留的、我们做得比业界好的

写这份东西的目的是改进，但不能为了对标把好东西改掉：

| 我们做的 | 为什么是对的 |
| --- | --- |
| **不画假进度百分比** | 全市场没有一个产品能给出可信的 %——`RunnerLane.tsx` 的判断被调研验证了 |
| **验收不采信 Agent 自述** | 41% 的用户经常遇到"说完成其实是坏的"；Cursor 为了这个专门做了 verification agent，我们是内建的 |
| **"宁可少标，不可多标"** | `decisionRules.ts` 的理由被数据完全支持：审批被打断会让 49% 的人觉得吃脑力、让 64% 的人草率点同意 |
| **超时自动拒绝而不是无限挂起** | 方向正确（Jules 的反面），只需要把超时**显示出来** |
| **连发不打断（消息排队）** | **故意的设计，判断是对的**：与 Copilot "Add to Queue" 同一机制。缺的只是把这句设计意图说给用户听（已在 Composer 上补提示） |
| **关窗口不退出** | 与 vibe-kanban 的核心洞见一致（"2–5 分钟的死等时间"） |
| **台账执行前落 pending** | 直接满足 arXiv 的 D3；比"事后记账"更可信 |

---

## 7. 未能核实的项（写文档时不要当作事实引用）

| 项 | 情况 |
| --- | --- |
| Claude Code 官方文档原文 | `code.claude.com` 在本机 DNS 解析失败，用了一份带 `source_url` 的逐字镜像（抓取于 2026-11-04~09）。`permission-modes` / `checkpointing` 的具体措辞属二手 |
| Codex CLI 官方文档 | `developers.openai.com` 不可达；用官方仓库 markdown + TUI 源码（UI 字符串权威）+ 一份第三方镜像 |
| Jules | `jules.google` 超时。7 分钟超时来自一个操作 Jules API 的开源 skill 仓库的实测值，不是官方文档 |
| Conductor | 全部 403，**没有任何可引用的具体机制** |
| Windsurf | 英文文档已跳转 `docs.devin.ai`（Windsurf→Devin Desktop），Cascade 内容取自中文镜像 |
| TRAE 宝 的用户好评 | 论坛存在**有奖测评**（"好评返现"），已剔除形容词类好评，只保留描述具体机制的 |
| 中文二手来源 | Reddit / HN 原页不可达（HN 用 Algolia API 取的同一棵评论树）；36kr 等站被反爬拦截 |
| "百分比进度" | 结论"没有产品做"是从**缺席**推出的，不是某个来源明说 |
| METR 的 19% 变慢 | 只在 arXiv 论文的引用里看到，原始论文未取到 |

---

## 8. 一句话给你

> 你手上产品的**机制**已经站在业界问题的正解上（分级审批、独立验收、可逆、只问该问的），
> 但**用户能碰到的那一层被 UI 重构做回了 0**；
> 而"要优化哪里"的答案不在功能清单里，在 §1.6 那张表——**十个接口、十个已经写好却没人调的模块，接上就是使用体验的提升**。
> 如果只做一件事：**让「需要你拍板」真的能当场拍板**——今天这个按钮看着像能用，按下去却什么都不发生，这是最容易让人放弃一款软件的那种细节。
>
> **更新（本次已修）**：用户叫停现在会**级联停掉所有 Agent**（在跑的 + 排队的），界面上有「停止全部」，旁边常驻一句说明"说话不会打断它们"。
> 详情见 §2.3 与 §5 第 4 条。
