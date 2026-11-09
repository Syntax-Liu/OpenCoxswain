# 可行性质疑回应与方案优化

> 回应对象：腾讯元宝分享页《项目可行性分析与问卷设计》（https://yb.tencent.com/s/nrOBdRPKfeK5）
> 核对基准：`docs/plan.md`、`docs/plugin-architecture.md`、`docs/super-agent-adoption.md`，以及当前代码（v0.8.0 之后的工作树）
> 结论性质：逐条判定 + 可执行改动，不写原则口号
> 配套问卷：`docs/questionnaire-v2.md`

---

## 0. 结论摘要

先把结果放前面。元宝一共提了六条质疑，外加一份「结论重写」。逐条比对代码后，判定如下：

| # | 质疑 | 判定 | 一句话结论 |
| --- | --- | --- | --- |
| 1 | 多员工线性放大监督负担；Watchdog 是唯一开关 | **半问倒**（定位对，概念错） | 它把「过程监察」和「结果验收」混成一个词。我们两件都做了，但只做完了代码类任务的那一半；而且代码默认结构性地要求人签每个子任务 |
| 2 | 共享上下文与执行隔离不能同时要 | **未击中现状** | 我们从未做共享可写上下文；但契约里也没有把「选隔离」写成不可回退的约束 |
| 3 | 0/5 委派实验证据强度不够 | **成立**（引用方式不当） | 函数写好了却没接线，文档却把一条弱证据写成硬约束 |
| 4 | 验收原语全是 Git，跨到通用办公就断 | **完全成立，最大盲区** | 证据类型枚举扩了，但没有一个非代码验证器；`rubric` 永远落到人 |
| 5 | 「可回滚的任务树」对有副作用执行不成立 | **成立**（过度承诺） | `plan.md` 原文就写着「可回滚」，代码里没有任何快照/补偿/幂等 |
| 6 | 授权离开单仓库就爆炸；员工包把配置成本转嫁用户 | **部分成立** | 我们的 `permissions` 其实已经是能力命名，但 Mandate 没落地、`write_scope` 仍是路径枚举、安装时没有能力差异提示 |

**三个必须立刻承认的事实：**

1. 系统复核（`SystemVerification`）只覆盖 `command` 与 `diff`；`rubric` / `human` 一律返回 `unverified`（[verification.ts:47-60](apps/daemon/src/verification.ts#L47-L60)）。所以「系统承担第一遍验收」目前只在代码任务成立。
2. 四个内置员工包的 `acceptanceDefaults` 全部带一条 `human`（`implementer.ts:14-16`、`writer.ts:14-17`、`researcher.ts:14-17`、`verifier.ts:14-17`），LLM Planner 的系统提示词也明文要求「每个子任务的 acceptance 至少包含一个 human」（`planner-llm.ts:38`）。这意味着**并行 3 个 worker 就至少产生 3 次人工确认**——元宝的「线性放大监督负担」不是推论，是我们代码里的默认行为。
3. 委派固化的断言函数 `validateDelegation` 已经写好了，但全仓没有任何调用方（[delegation.ts:21-44](packages/core/src/delegation.ts#L21-L44)）。这是死代码，不是已落地能力。

**三个不接受的地方：**

1. 「形态在 Agent 层自相抵消」——六条里只有第 4、5 条是真正的方向冲突；第 1、6 条是契约与排期问题；第 2 条我们本来就没选共享；第 3 条是引用问题。冲突被夸大成架构不成立。
2. 「Watchdog 是唯一开关」——DeepSeek 原文的 Watchdog 判断的是「worker 是否有实质进展、方向是否偏离」，属于过程监察；它不判断交付物对不对。把两者合并，会得出「做了 Watchdog 就等于能自动验收」的错误结论。
3. 「并行度 ≤ 1」——它把 DeepSeek 的「人通常只能同时跟进 3–5 个活跃 Session」改写成了「人日验收上限只有 3–5 次」，再假设每个任务节点都要人确认。这两步都不是原文。正确写法是条件式门禁，见 §2.7 与 §3.3。

**五个必须改的设计点**（详见 §2、§3）：

| 改动 | 落点 | 版本 |
| --- | --- | --- |
| 删除员工包默认 `human`，改为 `AcceptancePolicy` 三档 | `packages/shared/src/types.ts`、`apps/daemon/src/plugins/employees/*.ts`、`planner-llm.ts` | v0.9.0 |
| 非代码交付物的验证：`DeliverableProfile` + `ProvenanceVerifier` + `rubric` 证据绑定 | 新建 `packages/core/src/provenance.ts`、改 `apps/daemon/src/verification.ts` | v0.9.0 |
| 回滚降级为「可追溯 / 可补偿 / 仅 git 可回滚」，补 `SideEffect` + 幂等键 | 新建 `packages/core/src/side-effect.ts`、`store.ts`、`scheduler.ts` | v0.10.0 |
| `write_scope` 路径枚举升级为 capability Mandate | `packages/core/src/mandate.ts`、`employees/pack.ts`、`steward.ts` | v0.10.0 |
| 把 `validateDelegation` 接进 Planner，`DelegationMode` 三档 | `apps/daemon/src/planner.ts`、`planner-llm.ts` | v0.11.0 |
| 插件市场移出 v1 差异化叙事 | `plan.md:209`、`plugin-architecture.md:15` | 立即改文档 |

---

## 1. 材料可得性与核对方法

### 1.1 链接可读，无需浏览器

`https://yb.tencent.com/s/nrOBdRPKfeK5` 用普通抓取即可读取全文，返回 228 行，未触发登录墙、未依赖 JS 渲染后二次加载。因此本文对它的引用是原文，不是转述。

需要说明的是：这份材料的写法是「元宝对上一版调研报告的批评 + 重做问卷」，其中引用的 `§1.1`、`§3.1.3`、`§6.3` 等章节号指向的是它自己看到的那份上一版报告，**不是本仓库的文档**。所以本文在回应时，只对齐它的**主张**，不去猜它引用的编号。

### 1.2 事实基线：文档声称 vs 代码实况

这一步是全部判定的依据。此前 `super-agent-adoption.md` 的现状描述停留在 v0.5.0，之后代码已经走完 v0.7.0、v0.8.0，若不重新核对，回应就会答错。

| 能力 | 文档标注 | 代码实况 | 证据 |
| --- | --- | --- | --- |
| `command` 系统复核 | 已完成 v0.7.0 | 已实现：在 worktree 内独立重跑，退出码判定 | [verification.ts:66-110](apps/daemon/src/verification.ts#L66-L110) |
| `diff` 复算 | 已完成 | 已实现，但只比对 `git diff --numstat` 的增删行数，不比对内容 | [verification.ts:112-174](apps/daemon/src/verification.ts#L112-L174) |
| `rubric` / `human` 自动判定 | 未提 | **一律 `unverified`**，直接进人工 | [verification.ts:47-60](apps/daemon/src/verification.ts#L47-L60) |
| 逐条验收、理由必填、禁止批量 | 已完成 | 已实现；缺项返回 409，`passed` 记录不可覆盖 | [steward.ts:368-482](apps/daemon/src/steward.ts#L368-L482) |
| 员工自报不参与判定 | 已完成 | 已实现，自报只作为 `reported` 审计字段 | [scheduler.ts:1031-1055](apps/daemon/src/scheduler.ts#L1031-L1055) |
| 「在等谁」阶段视图 | 已完成 | 已实现，纯计算，不改状态机 | `packages/core/src/stage.ts`、[steward.ts:124-150](apps/daemon/src/steward.ts#L124-L150) |
| 运行中投递人的消息 | 已完成 v0.8.0 | 已实现；运行时支持则即送，否则排队到下次派发 | [contracts.ts:286-298](packages/plugin-api/src/contracts.ts#L286-L298)、[scheduler.ts:461-463](apps/daemon/src/scheduler.ts#L461-L463) |
| 规则监察 | 已完成 v0.8.0 | 7 条规则：越权、空转完成、无心跳、重复指纹、停滞、预算斜率、长尾 | [supervision.ts:126-185](packages/core/src/supervision.ts#L126-L185) |
| 委派结构断言 | 计划 v0.9.0 | **函数已写，无调用方** | [delegation.ts:21-44](packages/core/src/delegation.ts#L21-L44)，全仓 grep 无 `validateDelegation` 调用 |
| 任务级 Mandate | 计划 v0.9.0 | **未实现**，全仓无 `mandate` 代码 | grep 结果仅存在于 docs |
| `SideEffect` / 幂等 / 补偿 | 未列 | **未实现** | grep 无命中 |
| 上下文策略 | 未列 | **无契约字段**，但实际行为是隔离 | 无 `context_policy` |

结论：元宝基于「上一版报告」说「Watchdog 是文章级、原型未实装」，这句话对 DeepSeek 原型成立，对**我们**已经不成立；但它说「验收原语全是 Git」，对我们仍然成立，而且比它以为的更严重——非代码交付物连一个验证器都没有。

---

## 2. 逐条回应

### 2.1 质疑一：多员工并行线性放大监督负担，Watchdog 是唯一开关

**原文主张**

> 「每增加一个并行 worker，就多一条待验队列。若验收只能由人完成，员工越多，人越累，多员工是净负收益。」
> 「Watchdog 不是锦上添花，是这个形态能否成立的唯一开关：只有当系统能自己跑第一遍验收、只把低置信度与分歧交给人，并行度才可能大于 1。」

**事实核对**

它说对了一半，但把两个不同的系统组件合并成了一个词。

| 它说的「Watchdog」实际包含两件事 | DeepSeek 原文对应 | 我们的实现 | 状态 |
| --- | --- | --- | --- |
| 过程监察：worker 有没有实质进展、方向有没有偏、是不是在空转 | Watchdog（§6） | `supervisor.rules` + `core/supervision.ts`，7 条规则 | **已有** |
| 结果验收：交付物对不对、能不能自动判通过 | 不在 Watchdog 里，属于 Eval / 验收 | `SystemVerification`，只覆盖 command/diff | **半有** |

所以「Watchdog 是唯一开关」这个判断在概念上不成立：过程监察做得再好，也不会告诉你一份周报的第三个数字是不是编的。

但它真正致命的那句话是成立的，而且我们的代码比它描述的更糟：

- `verification.ts` 对 `rubric` / `human` 直接返回 `unverified`，没有校验员判定通道。
- 四个员工包的默认验收标准全部含 `human`。
- LLM Planner 提示词第 38 行要求「每个子任务的 acceptance 至少包含一个 human」。
- 根任务固定带 `{ id: 'human_accept', type: 'human' }`（`planner.ts:111-113`）。

把这四条合起来看：**当前系统在结构上保证了「子任务数 = 人工确认次数下限」**。并行 3 个 worker，人至少要签 4 次（3 个子任务 + 1 个根任务）。这正是元宝说的「线性放大」，而且不是没来得及优化，是默认设计。

**判定：半问倒。** 定位正确（这是形态成立与否的核心），概念错误（监察≠验收），现状判断过时（监察已落地），但对我们的实际后果判断准确（验收仍压在人身上）。

**要改什么**

| 改什么 | 落点 | 契约/数据 | 验收 |
| --- | --- | --- | --- |
| 新增 `AcceptancePolicy = 'auto' \| 'unverified_only' \| 'always_human'`，默认 `unverified_only`；含义是「系统能验完就不打扰人」 | `packages/shared/src/types.ts`（`TaskContract` 旁） | `TaskContract.acceptance_policy?: AcceptancePolicy`，缺省 `unverified_only` | 契约校验接受三档；`always_human` 与旧行为等价 |
| 删除四个员工包里的默认 `human`，改为「有可机械复核标准的给标准，没有的才留 human」 | `apps/daemon/src/plugins/employees/{implementer,writer,researcher,verifier}.ts` | `acceptanceDefaults` 只保留可验证项；`verifier` 的 `ac_human` 删除，改为 `rubric` + `evidence_required` | 内置员工新建计划后，子任务 acceptance 不含无条件 `human` |
| 根任务不再固定 `human_accept`，改为「任一子任务 unverified 时才要求人」 | `apps/daemon/src/planner.ts:111-113` | 根 acceptance 由子任务判定结果推导，或改为 `type: 'human'` 但 `evidence_required: ['human_note']` 且仅在存在 unverified 子任务时激活 | 全自动通过的任务，根任务不产生人工待办 |
| 改写 LLM 提示词第 38 行 | `apps/daemon/src/plugins/planner-llm.ts:38` | 改为「优先给可机械复核的标准（command / diff / assertion / anchor）；确实无法机械复核时才用 human，且必须写明为什么」 | 解析后统计：无必要的 `human` 比例下降 |
| 埋点 `human_touches`，按任务统计人工确认次数 | `apps/daemon/src/store.ts`、`steward.ts`、`scheduler.ts` | 新表或事件字段 `acceptance.human_touch`；派生指标 HTD | 任意任务可回放「人点了几次」 |
| 把「并行度门禁」写进版本门禁，而不是写成结论 | `docs/plan.md` §6.2 | 见 §3.3 | 门禁数值有出处、可复算 |

**没被问倒的部分：** `steward.decideAcceptance` 已经禁止一键全过、每条必须写理由、系统已复核的 `passed` 不会被人的结论覆盖。这套「验收留痕」是可用的，不需要重做，只需要把默认值从「人人必签」改成「例外才签」。

---

### 2.2 质疑二：共享上下文与执行隔离不能同时要

**原文主张**

> 「共享越深，一个 worker 读到的脏上下文 / 提示注入越容易横向污染其他 worker；隔离越彻底，中间产物就只能靠显式消息传递，等于要自己造一套带版本、带重放、带冲突裁决的分布式状态机。产品必须选边。」

**事实核对**

这条打的是「文档把三个都写成优点」，不是打我们的实现。

- 代码层面，每个 worker 在独立 worktree 内执行（`scheduler.spawn` → `worktreePath`），没有共享会话，没有共享可写目录。
- 跨任务传递只有两条路：`TaskContract.inputs`（静态）和 `TaskInput`（运行时消息），都是显式文本，不是共享内存。
- 产物是 `ArtifactRef` + sha256（`scheduler.ts:1008-1018`），合并靠 `git merge --no-ff`，冲突转人审。

所以「既要共享又要隔离」这个矛盾，我们没有犯。但有两个真问题：

1. 契约里没有 `ContextPolicy` 字段。现在的隔离是**实现选择**，不是**可审计的声明**。将来第三方员工插件如果要读别的任务上下文，没有任何字段能拦住它。
2. 「等于要自己造一套分布式状态机」这句夸大了。我们的状态不是分布式的：单一写入者 `Engine` + append-only 事件 + 不可变产物 hash，合并是 git 的事。这不是「造分布式状态机」，是「用 git 当合并层」。这一点它说错了。

**判定：未击中现状，但暴露了契约缺口。**

**要改什么**

| 改什么 | 落点 | 契约/数据 | 验收 |
| --- | --- | --- | --- |
| 新增 `ContextPolicy = 'isolated' \| 'summary' \| 'shared_readonly'`，默认 `isolated` | `packages/shared/src/types.ts` | `TaskContract.context_policy?: ContextPolicy` | 缺省行为与现在一致 |
| **禁止** `shared_writable`（不提供该枚举值） | 同上 | 枚举里就没有这一项 | 契约校验拒绝未知值 |
| `summary` 的语义写死：只传上游 `artifact.digest` + 一段由系统截断的摘要，不传原始会话 | `apps/daemon/src/scheduler.ts`（派发时组装 `inputs`） | `inputs.context_summary` 带上游 artifact hash 列表 | 回放能看到「这个 worker 看了谁的什么」 |
| 第三人员工包若声明需要跨任务上下文，安装时必须显示 capability 差异 | `apps/daemon/src/steward.ts` 安装流程 | 见 §2.6 | 安装页出现「可读取其他任务摘要」提示 |

---

### 2.3 质疑三：0/5 委派实验证据强度不够

**原文主张**

> 「那个 5 次 0 委派的实验，文档自己在附则里标注了『合成负载与简化环境，仅作初步参考』，却被用来支撑一条架构铁律——证据强度不够。」
> 「真正的设计问题是：Router 的分派规则是编译期固定编制，还是运行时在编制内动态改派？折中是有答案的（固定编制内允许改派，跨编制必须重新授权），但文档停在『要焊进系统层』就收笔了。」

**事实核对**

它说得对，而且我们的现状比它以为的更尴尬：

- `plan.md:208` 原文：「不依赖提示词让模型自行委派（DeepSeek Super-Agent 实验显示中性提示下 0/5 主动委派）」——把一次合成负载实验写成了第 4 条设计原则的依据。
- `packages/core/src/delegation.ts` 里 `validateDelegation` 已经实现了「非平凡任务必须拆、必须有可执行角色、必须有校验角色或人审」，但 `planner.ts` 和 `planner-llm.ts` 都没有调用它。
- 也就是说：**结构断言写好了，没接线；文档却把它当成硬约束在讲。**

这说明「委派固化」这件事我们信了，但只信在纸上。

**判定：成立（证据使用不当），且暴露死代码。**

**要改什么**

| 改什么 | 落点 | 契约/数据 | 验收 |
| --- | --- | --- | --- |
| 把 0/5 从「显示」降级为「支持性证据」，理由改为可审计性与成本可控，不再拿单次实验当铁律 | `docs/plan.md:208` | 见 §3.5 替换文案 | 文档不再出现「实验显示 → 因此必须」的推理 |
| `validateDelegation` 接进 `Planner.plan()`，失败即拒绝建计划 | `apps/daemon/src/planner.ts`（`plan` 返回前） | 复用 `DEFAULT_DELEGATION_POLICY` | 单测：非平凡目标 + 0 子任务 → 抛 `PLAN_NOT_DECOMPOSED` |
| 新增 `DelegationMode = 'fixed' \| 'reassign' \| 'open'`，v1 只允许 `fixed` | `packages/shared/src/types.ts` | `TaskContract.delegation_mode?`，缺省 `fixed` | `reassign` / `open` 在 v1 契约校验里直接拒绝 |
| 把「跨编制改派必须重新授权」写进 Mandate 规则 | `packages/core/src/mandate.ts`（v0.10.0） | 改派目标角色不在原 Mandate 的 `roles` 内 → 拒绝 | 单测：改派到编制外角色 → `mandate.denied` |

**为什么仍然要「固化」：** 理由不是那 5 次实验，而是三条可验证的工程约束——模型输出不稳定（同题不同拆法）、任务树要能审计（谁派给谁必须可回放）、成本要可归因（哪个角色花了多少钱）。这三条不需要实验支撑。

---

### 2.4 质疑四：验收原语全是 Git，跨到通用办公就断

**原文主张**

> 「数一遍文档里所有『验收』的证据源……无一例外是 Git 原语。一旦进到写周报、做竞品调研、扣子的通用办公，没有 diff、没有 CI、没有 merge 语义，『证据链』只剩截图和日志，而截图证明不了内容正确。」
> 「L2→L4 的跨越，缺的不是 UI，是一套非代码产物的可验证表示。」

**事实核对**

**这是六条里最狠、也最准确的一条。** 我们确实扩了证据类型，但没有扩验证能力：

| 层次 | 现状 | 缺口 |
| --- | --- | --- |
| 证据类型枚举 | `EVIDENCE_KINDS` 已有 `command_output / diff_stat / file / screenshot / link / human_note`（`types.ts:23-31`） | 枚举有了，但 `file / screenshot / link` 没有任何验证器消费 |
| 交付物类型 | `DELIVERABLE_TYPES` 已有 `diff / file / report / link`（`types.ts:36-37`） | `report` 没有对应的验收方式 |
| 验证器 | `SystemVerification` 只实现 `command` 与 `diff` | `rubric` 一律 `unverified`，等于「文档类任务 100% 靠人」 |
| 证据可信度 | `diff` 只比对增删行数，不比对内容 | 改 10 行删 10 行、内容全错，仍可能 `passed` |
| 来源追溯 | 无 | 调研结论标了「来源」也无法机检 |

结论：对文档、调研、数据、设计类交付物，我们的「自动预验」覆盖率是 **0%**。元宝说「缺一套非代码产物的可验证表示」，说的就是我们。

**判定：完全成立，最大盲区。** 这条必须改，而且优先级高于委派和 Mandate。

**要改什么**

核心思路：**不是让系统判断「写得好不好」，而是让系统判断「说的每一句有没有出处、数据对不对得上、结构合不合约定」。** 前者不可机械化，后者可以。

1. **新增 `DeliverableProfile`**

```
type DeliverableProfile = 'code' | 'document' | 'dataset' | 'design' | 'ops';
```

落在 `packages/shared/src/types.ts`，`TaskContract.deliverable_profile?: DeliverableProfile`。由员工包声明默认值（撰写员 `document`、调研员 `document`、实施员 `code`），Planner 可覆盖。

2. **扩展证据类型**（`types.ts:23-31`）

| 新增 | 含义 | 可机检条件 |
| --- | --- | --- |
| `assertion` | 一条可执行断言，脚本返回 0/1 | 有 `check` 命令，退出码决定 verdict |
| `anchor` | 结论到来源的锚点：`文件#L10-L20` / `URL#段落` / `数据集#行号` | 锚点可解析、目标存在、内容 hash 匹配 |
| `provenance` | 生成链：模型、工具、输入文件 hash、时间 | 字段完整且 hash 与输入一致 |

3. **新增 `ProvenanceVerifier`**

新建 `packages/core/src/provenance.ts`，由 `apps/daemon/src/verification.ts` 调用：

- 输入：交付物正文（`ArtifactRef` 指向的文件）、`evidence_required`、`criteria`。
- 抽检规则：每个 `rubric` 标准至少要求 3 条 `anchor`（可配置）；抽检结论与锚点内容做关键词/数字对齐。
- 判定：
  - 锚点全部可解析且内容匹配 → `passed`（`judgedBy: 'verifier'`）
  - 锚点缺失 → `unverified`
  - 锚点指向不存在的内容、或数字对不上 → `failed`
- 它**不判断文风、不判断观点对错**，只判断「有没有出处、出处是不是真的」。

4. **`rubric` 的判定权收紧**

现在 `rubric` 永远 `unverified`；改完之后允许 `judgedBy: 'verifier'`，但必须满足：

- `criterion.evidence_required` 非空，且对应证据全部就绪；
- 证据由 `system` 或 `verifier` 产出，不能是 `worker` 自报；
- 否则回落到 `unverified` 交人。

落在 `apps/daemon/src/verification.ts:47-60` 与 `packages/plugin-api/src/contracts.ts` 的 `VerificationService` 契约（新增可选 `profile` 与 `deliverable` 字段）。

5. **`diff` 补内容校验**

`verification.ts:112-174` 现在只比 `numstat`。补一条：产物自报的文件列表必须与实际 `git diff --name-only` 一致；关键文件（如测试、配置）内容 hash 纳入 `Evidence.digest`。避免「行数对上、内容全错」。

6. **按 profile 的验证矩阵**

| Profile | 必检 | 可选 | 永不自动判 |
| --- | --- | --- | --- |
| `code` | command、diff（含内容） | assertion | 架构合理性 |
| `document` | anchor（≥3/条）、provenance、结构断言（章节齐全） | link 可达性 | 观点是否正确 |
| `dataset` | schema 断言、行数/空值率阈值、抽样 hash | 分布漂移 | 业务含义 |
| `design` | 截图 + 尺寸/对比度断言、来源链接 | 视觉 diff | 美观 |
| `ops` | dry-run 幂等、变更计划 diff | 回滚演练 | 风险偏好 |

7. **抽样复核**

新增每周抽样：从 `judgedBy = 'system' | 'verifier'` 且 `verdict = 'passed'` 的记录里随机抽 20 条，人工复核，计算 `miss_rate`。落在 `apps/daemon/src/store.ts`（查询）+ 工作台（复核入口）。

**验收标准**

- 一个「竞品调研」任务，在零人工介入下能产出至少一条 `rubric` 的 `passed`，且该结论附带 ≥3 条可解析锚点；
- 抽检 20 条自动 `passed`，`miss_rate ≤ 2%`；
- 「编造来源」的测试样本必须被判 `failed`，不能只是 `unverified`。

---

### 2.5 质疑五：「可回滚的任务树」对有副作用执行不成立

**原文主张**

> 「LLM 执行不是纯函数：改了本地文件、发了消息、调了 API，都不能 undo。要回滚就得有快照 / 补偿事务 / 幂等重放——这是运行时基础设施，不是树形控件。文档把它和『两层任务树』放在同一条建议里，工作量被低估了一个量级。」

**事实核对**

`docs/plan.md:207` 原文：

> 「**任务树是审计对象**：可展开、可回滚、可重派，而不是并行会话列表。」

代码里与「可回滚」有关的实现是：worktree 可丢弃、分支可重建、合并冲突中止并清理。除此之外没有任何快照、补偿、幂等重放机制。`git` 范围之外的文件改动、IM 发送、API 调用，一律不可逆。

所以这不是「工作量低估」，是**当前根本没有任何实现，只有一句文档承诺**。

**判定：成立，过度承诺。必须改文档，也必须补基础设施。**

**要改什么**

把「可回滚」拆成三级，每一级写清能力边界：

| 级别 | 含义 | 覆盖范围 | 实现 |
| --- | --- | --- | --- |
| **L1 可追溯**（必做） | 发生过什么、依据是什么、谁判的，全部可回放 | 所有任务 | 已有：事件 append-only + 证据 + 产物 hash |
| **L2 可补偿**（部分） | 能撤销的撤销，不能撤销的提前拦 | 文件写/删、进程启动；外发类只记录不承诺撤销 | 新增 `SideEffect` 台账 + outbox + 幂等键 |
| **L3 可回滚**（仅 git 范围） | 丢弃 worktree、重置分支、重跑任务 | 代码仓库内 | 已有 |

具体改动：

| 改什么 | 落点 | 契约/数据 | 验收 |
| --- | --- | --- | --- |
| 新增 `SideEffect` 类型：`kind: 'fs.write' \| 'fs.delete' \| 'proc.exec' \| 'net.send'`，带 `idempotency_key`、`reversible: boolean` | 新建 `packages/core/src/side-effect.ts` | `idempotency_key = sha256(taskId + stepId + tool + normalizedArgs)` | 同键重复执行只生效一次 |
| 先记账后执行：工具调用前写 `side_effects`，执行后补 `result` | `apps/daemon/src/scheduler.ts`（`tool_call` 边界，现有审批逻辑 534 行附近） | 新表 `side_effects(id, task_id, kind, target, idempotency_key, reversible, state, created_at)` | 进程被 kill 后重启，未完成副作用可被识别 |
| `net.send` 类一律走审批，且 `reversible: false`；拒绝后写拒绝记录 | `apps/daemon/src/scheduler.ts` 审批五类动作 | 复用 `approvals` 表 | e2e：拒绝外发后无发送记录 |
| 文档口径改为「可追溯 / 可补偿 / 仅 git 可回滚」 | `docs/plan.md:207` | 见 §3.5 | 全文不再出现无条件「任务树可回滚」 |

**明确不做：** 文件系统全量快照、虚拟机级 checkpoint。成本与收益不成立，且会拖慢 Windows 本地的启动速度。

---

### 2.6 质疑六：授权模型离开单仓库就爆炸，员工包把成本转嫁用户

**原文主张**

> 「到了『本地任意文件夹 + 本地软件 + IM + 浏览器 + 20+ 渠道』，Ticket 的『范围』没法用确定性规则列全，§5.4 第 2 条『准入规则写成代码』就落不了地。」
> 「员工插件 = 角色 + 技能 + 工具 + 权限 + 验收标准。后两项由谁写？如果由用户写，等于要求每个用户兼任安全管理员和 QA。」

**事实核对**

这条一半对、一半低估了我们。

**低估的部分：** 我们的员工包 `permissions` 已经是能力命名，不是路径枚举：

- 实施员：`['fs:read', 'fs:write', 'shell:exec', 'test:run']`
- 调研员：`['fs:read', 'net:search']`
- 校验员：`['fs:read', 'shell:exec', 'test:run']`

也就是说，**员工包层面我们早就是 capability 模型**，元宝假设的「让用户枚举路径」在员工包里并不存在。

**说对的部分：**

1. 任务级的 `write_scope` 仍然是路径枚举（`['src/']`、`['**']`），到了「本地任意文件夹」确实列不全。
2. `Mandate` 还没实现，现在是「动作级审批 + write_scope」，没有任务级授权链。
3. 安装第三方员工包时，**没有任何界面告诉用户这个包会读什么、写什么、能不能联网**。`permissions` 只在 `provide()` 时做进程内可见性比对，用户看不到。
4. 验收标准确实由员工包作者写（`acceptanceDefaults`），用户只能接受。这一点元宝说反了——不是用户写，是作者写、用户被默认。但后果一样：用户不知道自己签的是什么。

**判定：部分成立。方向要改，但不需要推翻员工包模型。**

**要改什么**

| 改什么 | 落点 | 契约/数据 | 验收 |
| --- | --- | --- | --- |
| 把 `permissions` 正式定义为 capability 集合，统一命名 `fs.read / fs.write / net.read / net.send / proc.spawn / secrets.use`，旧字符串做映射表兼容 | `packages/shared/src/types.ts`（`EmployeeDefinition`）、`apps/daemon/src/plugins/employees/pack.ts` | `capabilities: Capability[]`，保留 `permissions` 作为别名一个版本 | 类型检查 + 旧清单仍可加载 |
| `TaskMandate` 只声明 `capabilities + root`，不枚举子路径；路径约束 = root + 相对 glob | 新建 `packages/core/src/mandate.ts` | `TaskMandate { id, taskId, capabilities, root, roles, expiresAt }`，不可变 | 越 root 写入 → `mandate.denied` |
| 项目创建只问三个问题：工作目录、能否联网、能否外发 | `apps/daemon/src/steward.ts`（创建项目）、工作台 | 生成默认 Mandate 模板 | 新项目默认 `fs.read + fs.write + net.read`，`net.send` 关闭 |
| 安装员工包时做 capability diff，用自然语言展示 | `apps/daemon/src/steward.ts` 安装流程 + `apps/desktop` 确认页 | `GET /api/employees/:id/capabilities` 返回 diff | 安装第三方包必现确认页，文案为「该员工可以读取你的文件、可以联网、不能外发消息」 |
| 验收标准不要求用户编写：员工包给默认值，安装页展示「它会按这几条验收」，允许改但不强制 | `employees/pack.ts`、工作台员工详情 | `acceptanceDefaults` 带可读 `desc` | 用户无需写任何验收标准即可创建计划 |
| 跨编制改派必须重新签发 Mandate | `scheduler.ts` + `mandate.ts` | 见 §2.3 | 改派到未授权角色 → 拒绝 |

**为什么不做「准入规则写成代码」：** 元宝批评得对，那等于要用户写策略。我们改成「能力声明 + 安装时差异提示 + 运行时越权拒绝」，用户只做三次选择，不写规则。

---

### 2.7 对「结论重写」的回应

**原文主张**

> 「文档描述的形态在 Agent 层自相抵消……值不值得推进，只取决于一个 Agent 本体命题：能不能让系统承担第一遍验收，把人的介入压缩到只处理例外。」
> 「答案为否：人工介入次数 ≈ 并行 worker 数 × 任务节点数，而人日验收上限只有 3–5 次 → 合理并行度接近 1。」
> 「答案为是：那这个项目的实质是一个『自动验收器 + 例外路由』系统，总管、员工编制、插件包、任务树全都只是外壳。」

**接受的部分**

1. **排序接受。** 验收能力必须排在总管叙事、插件市场、组织隐喻之前。我们把它从「P0 已做一半」提升为 v0.9.0 的主题，见 §3.2。
2. **指标接受。** `人工介入次数 / 有效交付数` 与 `漏检率` 是正确的主指标，比「想不想用」有意义。定义与阈值见 §3.3。
3. **kill criteria 接受。** 如果对照实验做不出净收益，就该退回事后审计工具，而不是继续堆功能。

**不接受的部分**

**（1）「形态自相抵消」夸大了。**

六条里真正的方向冲突只有两条：

- 第 4 条：编码验收原语 vs 通用任务 → 真冲突，必须补非代码验证。
- 第 5 条：可逆执行 vs 真实副作用 → 真冲突，必须降级承诺。

其余四条不是方向冲突：第 1 条是默认值配错了，第 6 条是契约粒度选错了，第 2 条我们本来就没选共享，第 3 条是引用强度问题。把四类问题打包成「形态不成立」，结论过重。

**（2）「Watchdog 是唯一开关」是概念合并错误。**

已在 §2.1 拆开。过程监察解决「它在不在干活」，结果验收解决「它干得对不对」。前者不能替代后者。我们的 `supervisor.rules` 已经能发现空转、停滞、重复、越权，但它永远不会告诉你调研报告里的数字是不是编的。

**（3）「并行度 ≤ 1」的推导有两处偷换。**

原文链条是：

> DeepSeek 说人只能同时跟进 3–5 个活跃 Session → 所以人日验收上限是 3–5 次 → 人工介入次数 ≈ 并行 worker 数 × 任务节点数 → 并行度 ≤ 1

两处问题：

- **偷换一：** 「3–5 个活跃 Session」是**同时跟踪的会话数**，不是**每天愿意做的确认次数**。前者是注意力带宽，后者是打断容忍度，两者量纲不同，不能直接替换。
- **偷换二：** `人工介入次数 ≈ 并行 worker 数 × 任务节点数` 假设**每个节点都要人确认**。这恰恰是自动预验要消除的东西。做完预验后，人工介入次数应趋近于「例外数」，而不是「节点数」。

正确的写法是条件式：

```
并行度上限 = min(
  日可接受打断次数 / (单任务确认节点数 × 日任务数),   // 人的带宽约束
  自动预验覆盖率 / 可容忍漏检率                        // 机器的可信度约束
)
```

其中 `单任务确认节点数` 在 `AcceptancePolicy = auto` 下应等于「例外数」，而不是「子任务数」。所以「并行度 ≤ 1」不是结论，是「自动预验覆盖率为 0」时的特例——正好是我们现在的状态，不是这个形态的天花板。

**（4）「总管、编制、任务树全是外壳」贬低过度。**

验收器是地基，但地基不产生差异化。真正难被复制的是三件事的组合：本地 worktree 隔离 + 任务树可审计 + 员工包可安装。单独一个「自动验收器」，任何编码工具都能加。我们接受「验收优先」，不接受「只做验收器」。

**（5）它自己的问卷设计有三处我们不采纳。**

| 元宝的做法 | 问题 | 我们的处理 |
| --- | --- | --- |
| 「不问身份：职业、岗位、行业、公司规模……一个都不问」 | 用户明确要求区分个人开发者 / 小团队 / 企业；而且插件付费意愿、仓库托付意愿在这三类人里差异极大，不问就测不出 | 身份题放最后（F 组），不分卷、不跳题、只做分组分析，避免 priming。见 `questionnaire-v2.md` §3 F 组、§6 |
| C3「一天愿意被打断几次」给「0 次，别来找我」 | 社会赞许性偏差：没人会说愿意被打断 | 改为行为题「最近 30 天，你因为确认 AI 产出被打断的实际次数」，并加「记不清」 |
| E3 只问月费档位 | 测的是价格锚点，不是付费距离 | 改为承诺阶梯（E6）：现在会不会付 / 涨价会不会走 / 什么条件下立刻停用 |

---

## 3. 方案优化

### 3.1 定位重写

**一句话：** 一个 Windows 本地优先、可审计、可安装员工的任务执行台——系统跑第一遍验收，人只处理例外。

**三层价值，顺序不能颠倒：**

1. **可信**（验收留痕）：每条结论有证据、有判定人、可回放。这是地基。
2. **吞吐**（并行分工）：在可信的前提下，多员工才有净收益。
3. **边界**（插件扩展）：员工包让能力可安装，但不承诺远程市场。

**明确不宣称：**

- 不宣称「通用办公全自动」。只承诺「有出处、可核对、可拒绝」。
- 不宣称「任意副作用可回滚」。只承诺「可追溯、部分可补偿、git 内可回滚」。
- 不宣称「插件市场」。v1 只有本地目录安装。

### 3.2 里程碑重排

原 `super-agent-adoption.md` 的顺序是 v0.7 验收 → v0.8 输入/监察 → v0.9 委派 + Mandate + 租约。按这次核对，把「验收闭环」单独拆出来并后移一个版本，理由是非代码验证的工作量被严重低估，不能和 Mandate 挤在同一个版本。

| 版本 | 主题 | 内容 | 为什么在这个位置 |
| --- | --- | --- | --- |
| v0.9.0 | **验收闭环** | `AcceptancePolicy` 三档；删除员工包默认 human；`DeliverableProfile`；`anchor / assertion / provenance` 证据；`ProvenanceVerifier`；`diff` 内容校验；抽样复核；HTD 埋点 | 元宝第 1、4 条；当前自动预验覆盖率对文档类为 0，这是形态成立的前提 |
| v0.10.0 | **授权与副作用** | capability `Mandate`；安装时 capability diff；`SideEffect` + outbox + 幂等键；三级可逆口径；`plan.md` 措辞修正 | 元宝第 5、6 条；没有它，非代码任务不敢放权 |
| v0.11.0 | **委派与恢复** | `validateDelegation` 接线；`DelegationMode = fixed`；租约式断点恢复；孤儿 worktree 清理 | 元宝第 3 条；死代码必须接线，但优先级低于验收 |
| v1.0 | **内测门禁** | HTD / miss_rate / false_alarm_rate 达标才发版 | 见 §3.3 |
| v1.x（条件触发） | 插件市场 | 本地安装 → 远程市场 | 仅当问卷 H14 显示「会装第三方插件」≥ 40%，且 capability diff 通过安全评审 |

**插件市场的处置：** 从 v1 差异化叙事里移除。现在 `plan.md:209` 写「Windows 本地优先 + 插件市场」，`plugin-architecture.md:15` 又把「远程插件市场」列为 P2+ 非目标，两处矛盾。统一口径为「本地可安装员工包」，远程市场改为条件触发项。

### 3.3 指标与门禁

**指标定义**（必须能被事件流复算，不能靠自报）：

| 指标 | 定义 | 数据来源 |
| --- | --- | --- |
| `HTD` | 每个有效交付任务的平均人工确认次数 = `human_touch` 事件数 / `done` 任务数 | `acceptance.decided` + 新增 `acceptance.human_touch` |
| `有效交付数` | 验收 `passed` 且未在 7 天内被打回的任务数 | `acceptance` 表 + `failed` 事件 |
| `miss_rate` | 抽样复核中「系统判 passed 但人判 failed」的比例 | 每周抽 20 条 |
| `false_alarm_rate` | 「系统判 failed 但人判 passed」的比例 | 同上 |
| `p95 交付时长` | 从 `queued` 到 `done` 的 95 分位 | 事件时间戳 |

**立项对照实验（不是发问卷，是跑任务）：**

- 同一批 20 个真实任务（必须来自实际使用，不能合成），随机分两组：
  - A 组：单 worker，全人工验收（基线）
  - B 组：3 worker + 自动预验 + 例外路由
- 记录 `HTD`、`有效交付数`、`miss_rate`、`false_alarm_rate`、`p95`。

**Go / Kill 判据：**

| 判据 | 阈值 | 含义 |
| --- | --- | --- |
| Go | B 组 `有效交付数 ≥ 1.5 × A 组`，且 `HTD ≤ 1.2 × A 组` | 并行确实带来吞吐，且没有把成本转成人的负担 |
| 条件 Go | `有效交付数 ≥ 1.2 ×`，`HTD ≤ 1.5 ×` | 可以继续，但必须先降 HTD 再谈扩张 |
| Kill | 6 周后 `HTD > 1.5 × A 组` 或 `有效交付数 < 1.2 × A 组` | 退回事后审计工具，砍掉多员工叙事 |

**发布门禁（v1.0）：**

- `HTD ≤ 1.0`（平均每个交付不超过一次人工确认）
- `miss_rate ≤ 2%`
- `false_alarm_rate ≤ 15%`——这条比漏检更关键：误报太多，人会训练成无脑点「通过」，等于验收器失效。
- 抽样复核覆盖率 100%（每周 20 条必须做完）

### 3.4 取舍决策表

| 项 | 原计划 | 新决定 | 理由 |
| --- | --- | --- | --- |
| 模型驱动 Watchdog（自由改提示词/触发规则） | 文章级，未做 | **不做** | 不可审计、不可回放；规则版已覆盖 7 类异常 |
| 共享可写上下文 | 未定 | **不做** | 污染面与注入面不可控；用 `ContextPolicy` 显式禁止 |
| 投机执行 | 不做 | **不做** | 与本地串行 worktree 冲突，收益不成立 |
| 文件系统快照 / VM checkpoint | 隐含在「可回滚」里 | **不做** | 成本高、拖慢 Windows 启动；只做 `SideEffect` 台账 |
| 远程插件市场 | v1 差异化 | **移出 v1** | 无行为证据支持「用户会装第三方插件」 |
| 员工包携带验收标准 | 五件套之一 | **保留，但改为可读默认值 + 安装时展示** | 不要求用户编写，只要求用户知情 |
| 0/5 委派实验 | 设计原则的硬依据 | **降为支持性证据** | 合成负载、样本 5 次 |
| `rubric` 永远交人 | 当前实现 | **改**：证据齐备时允许校验员判定 | 否则文档类任务覆盖率永远为 0 |

### 3.5 文档修正清单

以下替换文案可直接套用，不改结构、只改口径。

| 文件:行 | 现值 | 建议值 | 原因 |
| --- | --- | --- | --- |
| `plan.md:207` | 「可展开、可回滚、可重派」 | 「可展开、可追溯、可重派；回滚能力分级：可追溯（全量）/ 可补偿（文件与进程）/ 仅 git 内可回滚」 | 元宝第 5 条；当前无任何回滚实现 |
| `plan.md:208` | 「DeepSeek Super-Agent 实验显示中性提示下 0/5 主动委派」 | 「委派必须结构化，理由是可审计、成本可归因、模型输出不稳定（0/5 实验仅作支持性证据，样本为合成负载）」 | 元宝第 3 条 |
| `plan.md:209` | 「Windows 本地优先 + 插件市场」 | 「Windows 本地优先 + 本地可安装员工包」 | 与 `plugin-architecture.md:15` 冲突 |
| `plan.md:130` | 「插件/技能市场（可选）」 | 「远程插件市场（条件触发：问卷 H14「装现成」≥40% 且 capability diff 通过评审）」 | 同上，条件化 |
| `plugin-architecture.md:15` | 「插件热重载、远程插件市场、插件签名」列为 P2+ 非目标 | 保持，但加一句「v1 的插件能力是本地目录安装，不承诺远程市场」 | 消除与 plan 的叙事冲突 |
| `super-agent-adoption.md:21` | 版本节奏 v0.6–v0.9 | 按 §3.2 重排为 v0.9 验收闭环 / v0.10 授权副作用 / v0.11 委派恢复 | 验收工作量此前被低估 |
| `super-agent-adoption.md:19` | 「当前只有危险动作审批，没有任务级授权链」 | 保持；v0.10.0 完成后再改 | 事实正确，暂不动 |
| `super-agent-adoption.md` §5.1 | 只写 command/diff 复核 | 增补 `DeliverableProfile` 与 `ProvenanceVerifier` | 对齐 §2.4 |
| `docs/prd/OpenCoxswain-PRD.tex` | 「校验员独立复跑验收标准」 | 增补「非代码交付物按 profile 抽检锚点与断言」 | 与自动预验能力对齐 |

---

## 4. 与问卷的接口

问卷不是独立动作，它决定上表里哪些设计要加码、哪些可以砍。对应关系如下（题号见 `questionnaire-v2.md`）：

| 问卷假设 | 决定的设计参数 | 触发阈值 | 影响模块 |
| --- | --- | --- | --- |
| H3 人不是可靠的验收器 | 自动预验是否前置 | A5「经常发现不了」> 25% | §2.4 全部 |
| H9 打断预算 | `HTD` 目标值与并发默认值 | C3 中位 ≤ 2 且 C1 多选「逐条确认」→ 并行度锁 1；否则按 §3.3 门禁 | `scheduler.ts` `maxConcurrency` |
| H13 本地运行与仓库托付 | `ContextPolicy` 与 `Mandate` 默认值 | D6「不上传/不联网」进前二 > 50%；F3「不允许/需审批」> 40% → 默认只读 + 逐次授权 | `mandate.ts`、项目创建 |
| H14 插件安装门槛 | 插件市场是否排期 | E4「装现成」< 40% 或 E2「权限太多」> 40% → 市场无限期推迟 | §3.2、§3.4 |
| H15 付费距离 | 定价与免费额度 | E6 停在「留联系方式」> 50% → 先做免费工具，不排商业功能 | 商业模式，不改代码 |
| H11 授权可模板化 | 危险动作清单与审批粒度 | D2「一次说清」> 45% → 提高 Mandate 权重、减少逐次审批；否则保持逐次 | `scheduler.ts` 审批五类 |
| H12 权限/验收标准由谁写 | 员工包默认值是否可直接采用 | D4「模板 / 模板微调」> 60% → 用户不写验收标准，只确认 | `employees/pack.ts` |
| H8 自动预验接受度 | 例外路由的默认档位 | C1 选第二项 > 45% → `AcceptancePolicy` 默认 `unverified_only`；否则默认 `always_human` | `types.ts`、`steward.ts` |

问卷收回来后，先看 H3 / H9 / H14 三组；这三组决定「自动预验是否值得前置」「并行度上限」「要不要做市场」。其余假设用于调参，不用于改方向。

---

## 5. 结论摘要

1. **元宝六条质疑，两条完全成立（第 4、5），两条部分成立需要改设计（第 1、6），一条证据使用不当（第 3），一条未击中我们的实现（第 2）。** 没有一条能推翻形态，但第 4 条指出的是真空白：非代码交付物的自动验收覆盖率为 0。

2. **我们最该认的错误不是「没想到」，而是「默认值配反了」。** 员工包默认带 `human`、Planner 提示词强制每个子任务带 `human`、根任务固定 `human_accept`，三处叠加导致「子任务数 = 人工确认次数下限」。这恰好制造了元宝预言的「线性放大监督负担」。改为 `AcceptancePolicy` 三档即可解除，不需要改架构。

3. **它把「过程监察」和「结果验收」合成一个 Watchdog，是这份材料最大的概念错误。** 我们已经落地了前者（7 条规则），后者只做了 command/diff。正确的做法是两条腿分开补齐，而不是把 Watchdog 当开关。

4. **它的核心命题「系统承担第一遍验收，人只处理例外」应当接受，并作为 v0.9.0 的主题。** 但「并行度 ≤ 1」的推导有两处偷换（活跃会话≠日确认次数，节点数≠例外数），不能作为结论；只能作为「自动预验覆盖率为 0」时的特例，也就是我们现在的状态。

5. **方案层面的四个硬改动：** ①删除默认 human，改 `AcceptancePolicy`；②新增 `DeliverableProfile` + `ProvenanceVerifier` + 锚点/断言/来源链证据；③回滚降级为三级并补 `SideEffect` + 幂等；④`write_scope` 升级为 capability Mandate + 安装时能力差异提示。四件事分别落在 v0.9.0 与 v0.10.0，不与其他功能挤版本。

6. **文档必须同步修口径：** `plan.md:207` 的「可回滚」、`plan.md:209` 与 `plugin-architecture.md:15` 的插件市场矛盾、`plan.md:208` 的 0/5 证据强度。这三处不改，下一轮评审还会被同样的问题问住。

7. **验证方式必须换：** 不再用问卷问「想不想用」，改为「单 worker 基线 vs 三 worker + 自动预验」的对照，只记 `HTD`、`有效交付数`、`miss_rate`、`false_alarm_rate`。达不到 Go 判据就退回事后审计工具，这是事先写死的 kill criteria。
