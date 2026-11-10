# OpenCoxswain · 舵手

本地优先的 Windows AI 总管。你只对总管说话；总管把目标拆成结构化任务单和 DAG，派给在独立 git worktree 里干活的 AI 员工，盯进度、做验收，最后按固定三块汇报：待你决策 / 未通过的检查 / 交付产物。

当前版本 `0.32.0`，处于实施计划的 P3 收尾 / P4 起步：插件化内核、OpenCode 运行时与 LLM Planner 已就绪，预算硬停、危险动作人审、DPAPI 密钥托管、失败重试、冲突转人审、成本报表与回放导出已接入；员工角色已改为可安装插件包，验收改为系统复核 + 逐条人工决策，运行中可投递消息并由规则监察兜底；v0.9.0 补齐验收闭环（AcceptancePolicy / DeliverableProfile / 来源链校验 / 内容级 diff）、运行租约与孤儿恢复、任务级授权链；v0.10.0 补上副作用台账与能力化授权；v0.11.0 补齐委派与恢复（任务树重派、孤儿 worktree 清理、DAG 可视化、待决策收件箱）；v0.12.0 加入记忆层与记忆检查器；v0.13.0 接入 Tauri 2 桌面壳与 NSIS 安装包；v0.14.0 让子任务完成即可单独验收（根任务仍保留最终收口），验收单改为四段决策说明，并记录完成 → 首次查看 → 作出决定三个时间点，提供 p50/p95 反馈延迟接口；v0.15.0 补齐交付最后一公里：交付说明复用决策说明四段，一键合并仅在低风险交付开放且必须二次确认，失败自动回滚，并为未过期租约补上 `recovered_unknown` 现场标记；v0.16.0 把整块 diff 拆成可逐文件展开的明细（二进制与大文件显式提示），并让任务树节点成为可展开的审计对象，直接标出失败 / 阻塞卡点；v0.17.0 补上首次上手路径（接入仓库 → 生成任务单 → 确认开工，失败给可读原因）与多项目切换（项目配置、任务树、事件、消息按项目隔离，最近项目本地记忆）；v0.18.0 加入任务模板：修缺陷 / 小功能 / 写文档 / 重构 / 调研五类默认值经插件注册，套用前即可看清默认交付物、验收方式、写入范围与合并开关，套用后仍要用户确认开工，模板不能自动放行验收；v0.19.0 加入定时任务：按项目配置间隔到点只生成一张待审批任务单，不自动开工，项目里有未完成任务时整次跳过，错过时段不补跑；v0.20.0 加入全局路由与跨项目记忆检索：一句话目标按本地规则映射到已有项目并列出命中依据，只给建议不建单；记忆搜索可跨全部项目与全局，且检索不改写使用统计；v0.21.0 补上模型密钥设置入口：设置页可直接保存/清除 API Key（只存本机 DPAPI，不回传明文），保存后刷新即可在静态规划与 LLM 规划之间切换；v0.22.0 收口发行：安装包自带 Node.js 运行时，装完不再要求系统预装 Node（开发与构建仍需 Node >= 22）；v0.23.0 补上门禁质量统计：把系统自动判定、系统拦下、待人工与人工收口的数量分开记账，成本页可直接看到自动通过率与人工通过率；v0.23.1 修掉中文与空格路径下 git 把文件名转义成八进制的问题，worktree、diff 产物与逐文件明细都按原始文件名展示；v0.23.2 修掉 Windows 长路径的两个坑：进程工作目录超过 260 字符时 daemon 会直接崩溃，现在改为返回可读中文原因并在建立 worktree 前拦下；git 调用同时打开 `core.longpaths`，仓库路径不长时深层文件也能正常入库；v0.24.0 收口进程清理：验收命令与系统复核超时后按整棵进程树结束，不再残留孙进程占住 worktree；daemon 退出、未捕获异常与未处理拒绝都会先收回活跃 OpenCode 会话；桌面壳退出改为结束 daemon 进程树，关掉应用后不再留下后台员工进程；v0.25.0 补上 PID 台账：OpenCode 进程启动即记账、退出即销账，daemon 下次启动按台账回收上次被强制结束后仍存活的进程树，进程名对不上（PID 已被复用）只清记录、不误杀无关进程；v0.26.0 加入 IM 通知与指令通道（先做飞书）：设置页可配飞书机器人 Webhook 与签名密钥，审批请求、待验收、预算超限、执行失败与遗留进程回收按类别推送，同类事件在 60 秒静默窗口内只推一条，群里可直接发「待办 / 状态 / 批准 / 退回」，只读查询与拍板动作可用但不开放建单，入站支持签名校验与加密回调；v0.27.0 加上自动更新：设置页能看当前版本、检查新版本、看发布说明并一键安装后重启，更新源地址与公钥放本机 `updater.json`，未配置时不发网络请求；v0.28.0 接入远程执行体骨架：任务分支打包后交给远程节点执行，节点心跳领活、离线即退回队列，验收仍在本地重跑；v0.28.1 修掉安装后双击静默退出；v0.29.0 在设置页补上远程节点管理（开关、接入令牌、在线状态与移除）；v0.30.0 把 IM 通道扩到 Telegram：设置页可填 Bot Token 与会话 ID，通知类别与 60 秒静默窗口和飞书一致，群里同样发「待办 / 状态 / 批准 / 退回」处理，入站用 `setWebhook` 的 `secret_token` 校验、按 `update_id` 去重，只接受绑定会话的指令；v0.31.0 重构工作台界面：右侧改为可折叠上下文栏，页面收敛为单页主区，删除抽屉式面板与重复标题，字号统一到 12 / 13 / 15 / 20 四档；v0.32.0 让 IM 通道可以建单：群里发「任务 <目标>」直接生成待审批任务单，多项目时用「任务 #项目名 <目标>」指定，只落待审批、不自动开工，目标为空或项目对不上都会给出可读原因，批准后才派发。

## 快速开始

要求：

- 源码开发：Node.js >= 22（使用内置 `node:sqlite`，无需编译原生模块）、pnpm >= 9
- 桌面壳：WebView2（Windows 11 自带）；从源码构建安装包另需 Rust stable 与 VS Build Tools（MSVC + Windows SDK）
- 安装包已自带 Node.js 运行时，目标机器不需要预装 Node；git 仍需随系统安装（worktree 与合并依赖它）

```bash
pnpm install
pnpm dev
```

- 工作台：http://127.0.0.1:5173
- Daemon：http://127.0.0.1:47821（仅监听本机）

首次打开时填入一个已存在的 git 仓库路径（至少有一次提交），按左栏「第一次使用」三步走：接入仓库 → 对总管说一句目标生成任务单 → 看过执行清单后点「确认开工」。接入失败会直接说明原因（路径不存在 / 不是 git 仓库 / 仓库为空 / 没有权限），不需要先读文档。左栏「项目」面板可在多个仓库间切换或接入新项目，项目配置与任务树彼此隔离。新建任务前可在输入框上方选任务模板，预览它的默认交付物、验收方式、写入范围与合并开关；套用后仍停在「待确认」。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 构建并同时启动 Daemon 与 Vite 工作台 |
| `pnpm build` | 构建全部 workspace 包与工作台静态资源 |
| `pnpm typecheck` | 全仓 TypeScript 严格检查 |
| `pnpm test` | core 单元测试 + daemon 端到端集成测试 |
| `pnpm e2e` | 独立跑一遍 v0 剧本并打印进度 |
| `pnpm e2e:opencode` | 可选：用本机 OpenCode CLI 跑真实员工链路（未安装时跳过） |
| `pnpm desktop` | Tauri 2 开发态：自动拉起 daemon 与 Vite，打开桌面窗口 |
| `pnpm desktop:build` | 打包 daemon 资源并构建 Windows NSIS 安装包 |
| `pnpm desktop:release` | 同上，并为安装包产出自动更新签名 `.sig`（需要签名私钥） |
| `pnpm package:daemon` | 只把 daemon 与工作区包产物摊平到 `apps/desktop/src-tauri/staging` |

## 目录

```
apps/
  daemon/      # 本地核心：HTTP/SSE、SQLite、调度器、总管编排、worktree
  desktop/     # React 18 + Vite 工作台 + Tauri 2 桌面壳（src-tauri）
packages/
  shared/      # ID、时间、领域类型与 API DTO
  core/        # 任务契约、状态机、DAG、预算、汇总、工具白名单
  adapters/    # RuntimeAdapter 接口 + Mock / OpenCode 适配器
  plugin-api/  # 插件契约：Manifest、PluginContext、服务表、权限
docs/
  prd/         # PRD 原文（tex + pdf）
  plan.md      # 分阶段实施计划与取舍
  plugin-architecture.md
  spike-opencode.md
  super-agent-adoption.md
```

## 当前能力（v0.31.0）

已实现：

- 任务单校验、状态机、DAG 依赖、写域冲突、预算守卫、三块汇总。
- SQLite 持久化（`node:sqlite`），事件 append-only，可回放、可导出。
- 每任务独立 worktree 与分支；调度器按依赖/并发/写域派发。
- 审批开工、打回、暂停/继续/终止、验收。
- 预算硬停：运行中实时累计成本，任务或项目日预算超限立即停止执行并产出「待你决策」。
- 危险动作人审：delete / push / publish / pay / external_send 在建审批记录后冻结，等待批准或拒绝；支持原生闸门的运行时在执行前挂起。
- DPAPI 密钥托管：LLM Key 按当前 Windows 用户加密落盘，读取优先仓库、回退环境变量；明文不写入文件。
- 失败重试矩阵：运行时返回可重试错误时自动重试一次，仍失败则升级「待你决策」；用户可 `POST /api/tasks/:id/retry` 重新排队。
- 顺序合并与冲突转人审：多依赖任务在新 worktree 内按依赖顺序合并分支，冲突时中止并建 `merge_conflict` 审批，不触碰用户主分支。
- 成本报表：`GET /api/projects/:id/costs` 汇总总成本、按模型/任务/日分组。
- 回放导出：`GET /api/tasks/:id/replay?format=markdown` 导出任务标题、子任务、员工、审批、产物、验收结论与证据、事件时间线与汇总。
- 员工插件包：角色 + 技能 + 工具白名单 + 能力集合 + 默认验收标准五件套由插件注册；调研员/实施员/校验员/撰写员均走同一加载路径，`GET /api/employees` 可查看已安装员工，`GET /api/employees/:id/capabilities` 在安装前展示能力差异（如「可以向外部发送消息」需项目额外授权）。
- 验收自证：员工自报只作审计；`command` 验收由系统在 worktree 内独立重跑，`diff` 做内容级复算（路径 + patch sha256 + 增删行数任一不符即失败），`rubric` 按 `assertion` / `anchor` / `provenance` 证据绑定判定，`human` 保留但不再默认出现。
- 验收策略：`AcceptancePolicy` 三档（`auto` / `unverified_only` / `always_human`，默认 `unverified_only`）配合 `DeliverableProfile`（`code` / `document` / `dataset` / `design` / `ops`）；文档类交付物由 `ProvenanceVerifier` 校验锚点与来源链，非 Git 交付物也有自动预验路径。
- 委派结构断言：Planner 产出的根任务必须拆出 2–5 个子任务且含实施/撰写与校验角色，否则以 `PLAN_NOT_DECOMPOSED` / `PLAN_INVALID` 阻塞，不进入派单。
- 运行租约与孤儿恢复：每次运行持有租约（默认 30s，`OPENCOXSWAIN_LEASE_MS`），调度器 tick 续租；进程崩溃或超时后运行被标记为孤儿，失败对应 worker、注入「上次执行被中断…」后重新排队，`GET /api/runs/orphaned` 可查。
- 任务级授权链：审批或人工重派时为子任务签发不可变 `TaskMandate`（能力集合 `fs.read` / `fs.write` / `net.read` / `net.send` / `proc.spawn` / `secrets.use`、授权根目录、可执行角色、预算、有效期），不再枚举写路径；派单前校验角色编制否则 `MANDATE_INVALID`，运行中每次工具调用校验能力与路径是否越出根目录/写域并落 `mandate.denied`；`GET /api/tasks/:id/mandate` 可查看当前授权。
- 副作用台账：`fs.write` / `fs.delete` / `proc.exec` / `net.send` 在工具调用边界先落 `pending` 再执行，收到结果后结算为 `succeeded`，审批拒绝记为 `rejected`；幂等键为 `sha256(taskId + tool + 规范化参数)`，文件写/删与外发按幂等键去重，进程执行只记账；`GET /api/tasks/:id/side-effects` 与回放可查全部动作。外发一律需要审批且标记为不可逆。
- 项目授权三问：创建项目只问工作目录、能否联网、能否外发；默认允许联网读取、禁止外发。员工声明的能力与项目边界取交集后写入 Mandate，缺能力时在派单前拒绝。
- 可补偿而非全量回滚：文件写/删标记为可补偿，进程与外发标记为不可逆；不提供文件快照或 VM checkpoint，回滚能力分级为可追溯 / 可补偿 / 仅 git 内可回滚。
- 任务树重派：`failed` / `blocked` 子任务可改派给其他编制角色；同编制只换人，跨编制自动重签 `TaskMandate` 并落 `task.reassigned`，仅清理 worktree 后重新执行，不做文件级回滚。
- 委派模式：v1 只接受 `delegation_mode = fixed`，Planner 与手工任务单一致；其他模式在契约校验阶段以 `delegation_mode` 错误拒绝，不进入派单。
- 孤儿 worktree 清理：重启恢复时只清理 `done` / `cancelled` 任务的 worktree；`failed` / `blocked` 保留现场供排查，清理失败落 `worktree.remove_failed`。
- DAG 可视化：任务树按依赖拓扑分层，同层可并行，`status-*` 直接反映 blocked / failed / running，子任务失败时就地显示重派入口。
- 待决策收件箱：左栏聚合待审批、失败/阻塞子任务、根任务待开工与全部待验收任务（含子任务），按完成时间展示「已等待」；根任务在子任务未收齐时显示「汇总中 N/M」。每条都能直接操作（批准 / 退回 / 重试 / 取消 / 重派 / 去验收）。
- 记忆层：`packages/memory` 以 SQLite（FTS5）为唯一事实来源，中文按二元组切分索引，检索为关键词覆盖率 + 时间衰减混合排序；Markdown 快照导出到 `memory/`（`user_profile.md` / `decisions.md` / `lessons.md`，项目级 `projects/<id>/`），文件头标注自动生成。
- 写入门槛：记忆必须带来源，拒绝临时指令（「这次…」）、疑似密钥与过短内容；同键新结论自动取代旧记忆，旧记录不再参与检索；重复内容直接去重。
- 记忆消费：LLM Planner 提示词注入命中的记忆；总管在任务单消息中固定输出「我参考了这些记忆」并落 `memory.used` 事件；创建项目时轻量识别技术栈写入项目记忆（只读标记文件，不执行命令）。
- 记忆检查器：`GET /api/memory/check` 报告重复、无来源、疑似密钥、同键冲突与一年未使用的陈旧记忆；工作台「记忆」页可搜索、手动新增与删除。
- 逐条验收：`POST /api/tasks/:id/acceptance` 接受任意处于 `awaiting_review` 的任务；子任务完成即可单独验收，根任务仍由人做最终收口。每个未通过验收项单独给结论和理由，缺结论返回 409、缺理由返回 400；不再有「一键全部通过」入口。
- 验收留痕：evidence 与 acceptance_records 落库，记录交付物、证据摘要、验收标准、验收人（系统/人）与结论，可回放。
- 决策说明：`GET /api/tasks/:id/brief` 与快照 `briefs` 返回四段结构化说明（改了什么 / 为什么 / 验过什么 / 还有什么风险）与冲突判定理由；说明由任务契约、产物和系统复核记录生成，员工自述不参与，证据默认折叠。
- 反馈延迟：任务表记录 `finished_at`、`first_viewed_at`、`decided_at`；首次打开验收单会 `POST /api/tasks/:id/viewed`。`GET /api/review-latency?projectId=` 与快照 `review` 给出完成→查看、完成→决定的 p50/p95 与当前等待数，收件箱标注每条已等待时长。
- 门禁质量：`GET /api/gate-quality?projectId=` 从验收事件按「任务 + 验收项取最后一次判定」聚合，分别给出系统自动判定数、系统通过数、系统拦下数、待人工数、人工收口数与两者通过率；没有样本时通过率返回 `null` 而不是 0。系统判失败会直接让任务失败、不接受人工覆盖，所以这里只做分布统计，不改验收记录，也不提供「误报率」这类无法从事件里证实的数字；成本页新增「验收门禁」一块展示。
- 交付说明：`GET /api/tasks/:id/delivery` 复用决策说明四段，另列目标分支、待合并分支、改动规模、回退命令、风险与阻塞原因；仅根任务有交付入口，风险由系统按交付物类型、删改行数与副作用计算，不采信员工自述。
- 一键合并（需确认，仅低风险）：`POST /api/tasks/:id/merge` 要求 `confirm: true` 且 `planHash` 与当前计划一致；只有全部子任务交付物为 document、无删除行、无 `fs.delete` / `net.send` 副作用、无未决审批与合并冲突时才判低风险并开放；系统合并失败自动 `git merge --abort` + `git reset --hard` 回滚到合并前提交，高风险只展示分支与手动处理指引。
- 租约现场标记：租约未过期时重启不判孤儿，保留 `running` 并落 `recovered_unknown`，由 supervisor 继续观察；租约过期才回收 run、任务回 `queued` 并注入上下文。
- 逐文件审阅：`GET /api/tasks/:id/diff-review` 把 diff 拆成按文件明细（新增 / 删除 / 重命名、增删行数），每个文件可展开 / 折叠；二进制与超长文件必须显示提示，不静默截断；根任务汇总子任务同一路径并明确提示合并；验收单、交付说明与产物面板共用这份明细，挂在四段说明的「改了什么」下。
- 进程清理：验收命令与系统复核命令超时后按整棵进程树结束（Windows `taskkill /T /F`，POSIX 按进程组），不再残留孙进程占用 worktree；内核停止时收回所有活跃 OpenCode 会话，未捕获异常与未处理拒绝同样走一次卸载；桌面壳退出改为结束 daemon 进程树，关掉应用不会留下后台员工进程。
- PID 台账：OpenCode 进程启动时写入 `<home>/pids/<pid>.json`（可执行文件名、任务、worktree、启动时间），正常结束、超时、取消都会即时销账；daemon 启动时（`runtime.opencode` 的 `reapOrphans`）回收上次被任务管理器强杀后仍存活的进程树，进程名与台账不符（PID 已被系统复用）只删记录、不误杀无关进程。
- 任务树审计：节点可展开查看负责人、分支、当前阶段、逐条验收结论与最近关键事件；失败 / 阻塞 / 被打回在卡片上直接显示「卡在：…」，事件可回溯；DAG 只保留依赖关系。
- 首次引导：首次启动直接进入接入表单；`inspectRepo` 区分路径不存在、不是文件夹、没有权限、不是 git 仓库、git 不可用与空仓库，接口以 400 返回可直接展示的中文原因，不把错误码甩给用户。对话页空状态只保留一句话目标提示，不再重复三步清单。
- 多项目：左侧边栏「项目」列表可在多个仓库间切换，也可直接接入新项目；任务、事件、消息、产物、审批、验收与记忆统计均按 `project_id` 隔离，项目级预算与并发上限各自独立；最近使用的项目记在本地，下次启动优先恢复。
- 任务模板：内置「修缺陷 / 小功能 / 写文档 / 重构 / 调研」五类，由 `template.registry` 插件登记，`GET /api/templates` 与工作台快照可读。每个模板声明目标描述、默认交付物、验收方式、写入范围、是否允许一键合并；选中后在输入框上方完整预览，并注明项目级联网 / 外发授权。套用模板只预填任务单（主执行 + 校验两个子任务），仍停在「待确认」，`acceptancePolicy` 固定为 `unverified_only`，交付阶段只有模板允许且低风险时才开放一键合并。
- 定时任务：`schedules` 服务 + `trigger.schedule` 插件，`GET/POST /api/schedules`、`POST /api/schedules/:id/enabled`、`POST /api/schedules/:id/run`、`DELETE /api/schedules/:id`。每条任务属于一个项目，声明标题、目标、可选模板与间隔（1 分钟起）；到点只调用 `steward.createPlan` 落一张 `awaiting_approval` 任务单，不自动开工、不降低验收强度；项目已有未完成任务时整次跳过并落 `schedule.skipped`，错过时段不补跑，下一次按间隔重算。侧边栏「自动化」页可新建、停用/启用、立即生成与删除。
- 全局路由：`router` 服务 + `router.global` 插件，`POST /api/route` 只返回候选项目、分数与命中依据（项目名/路径、项目记忆、最近任务），最多 3 个候选、3 条理由，不做语义模型推断，不建单、不改项目状态；是否派活由用户在「生成任务单」时决定，任务单仍停在待确认。
- 跨项目记忆检索：`GET /api/memory?scope=all&q=` 覆盖所有项目与全局记忆，结果自带 `projectId` 由界面分组；检索只读，不改写 `useCount` / `lastUsedAt`，因此不会污染时间衰减排序。不带 `scope` 时语义不变（只查全局记忆）。工作台「记忆」页提供跨项目搜索。
- 阶段视图：`GET /api/tasks?stage=person|working|idle` 与工作台「在等谁」标签，明确当前是等人、等依赖还是执行中。
- 运行中输入：`POST /api/tasks/:id/inputs` 给执行中的员工发消息；运行时支持则立即送达并落 `input.delivered`，不支持则诚实地排队到下次派发（`input.queued`），人的消息不受并发上限约束。OpenCode 以 worktree inbox 文件排队，绝不谎报已送达。
- 规则监察：`supervisor.rules` 插件按规则检查越权写入、空转完成、无心跳、重复调用、停滞、预算逼近与长尾；动作写入 `supervision_actions` 并进入回放，同一规则重复触发升级为暂停。只做规则判断，不调用 LLM、不改提示词。
- Mock 运行时：真实写文件、跑验收命令、产出 diff 与报告，离线可跑。
- OpenCode 运行时：调用桌面版 CLI 执行真实任务，JSONL 事件映射、会话隔离、进程树终止。
- LLM Planner：OpenAI 兼容端点，BYO Key；无 Key 自动回退静态拆分，侧边栏底部常驻「LLM 规划」/「静态规划」状态点，悬停可看原因，`GET /api/secrets` 可查看 Key 是否已配置。设置页「模型密钥」可直接保存/清除 Key，只存本机凭据库（Windows DPAPI），保存后点主区刷新即可切换规划模式。
- 模型密钥设置：设置页显示当前是否已配置及来源（本机凭据库 / 环境变量），`PUT/DELETE /api/secrets/llm` 保存与清除；密钥不回传明文、不写项目文件，清除后规划立即回落静态规则。
- Windows 路径：git 调用统一关掉路径转义并按长路径处理，中文加空格的文件名在 worktree、diff 产物与逐文件明细里都保持原样；进程工作目录超过 260 字符时不再让 daemon 崩溃，改为在接入项目与会话启动处返回可直接展示的中文原因；仓库路径不长时，超过 260 字符的深层文件仍能正常加入版本库。
- 三栏工作台：左侧边栏放品牌、新建任务、页面导航、项目列表与 Planner / 运行时状态；中间主区由统一标题栏承载页面标题、任务状态与刷新，对话页为 Trae 风格输入框；右侧上下文面板可折叠，容纳员工、时间线、汇总。页面切换与上下文开关状态记在本地，窗口窄于 1180px 时默认收起右栏。
- 浏览器工作台页面：对话、待决策、任务、产物、自动化、记忆、花费、项目、设置。
- Tauri 2 桌面壳：Rust 侧拉起并托管本地 daemon（固定 127.0.0.1:47821），端口就绪后再开窗，退出时结束子进程；日志在 `%LOCALAPPDATA%\OpenCoxswain\logs\daemon.log`。`pnpm desktop` 为开发态，`pnpm desktop:build` 产出 currentUser 模式的 NSIS 安装包，daemon 与工作区包由 `scripts/package-daemon.mjs` 摊平进安装资源。
- 自带运行时：打包时把构建机的 Node.js 可执行文件与许可证复制到 `staging/runtime`，桌面壳优先用它启动 daemon（可用 `OPENCOXSWAIN_NODE_BIN` 覆盖），找不到或启动失败才回退系统 `node`，并在日志里写明用了哪一个。安装包因此不再要求目标机器预装 Node.js。
- IM 通道（飞书 / Telegram）：`channels` 服务负责配置落盘（`<home>/channels.json`）、事件路由与去重，`channel.feishu` / `channel.telegram` 插件各自负责发送与入站回调。设置页可保存飞书 Webhook 与签名密钥，或 Telegram 的 Bot Token 与会话 ID，并配置通知类别与启停；凭据保存后不回显明文，入站地址与 token 可直接复制。审批请求、待验收、预算超限、执行失败、遗留进程回收按类别推送，同一事件 60 秒内只推一条。群内发「待办 / 状态 / 批准 / 退回」即可查询与拍板，退回必须带理由；发「任务 <目标>」可直接生成待审批任务单，多项目时用「任务 #项目名 <目标>」指定，目标为空或项目对不上都会给出可读原因。建单只停在待审批，不会自动开工，也不跳过验收，仍需在任意一端批准后才派发。飞书入站支持 `X-Lark-Signature` 校验与 `encrypt` 字段解密；Telegram 入站路径为 `/api/channels/<id>/inbound/telegram`，`setWebhook` 时把入站 token 填作 `secret_token`，请求按 `update_id` 去重，non-command 消息与未绑定会话一律忽略；Telegram 只要求公开 HTTPS 回调，纯本机测试可只配 Bot Token 与会话 ID 收推送，要发指令再用隧道把入站地址暴露出去。
- 自动更新：桌面壳内置 Tauri Updater，设置页「版本与更新」显示当前版本、检查新版本、查看发布说明并一键安装，安装完成后自动重启。更新源地址与公钥放在本机 `updater.json`，不写进仓库；未配置时不发任何网络请求，只在界面上提示怎么配。
- 远程执行体：`remote` 运行时把任务分支打包（`git bundle`）交给远程节点，节点改完提交后回传代码包，适配器把分支拉回本地 worktree，再由调度器在本地重跑验收——节点自报的「已完成 / 已通过」一律不采信。协调器（`remote` 服务）默认关闭，开启后签发接入令牌，节点主动连入注册、每 10 秒心跳领任务，30 秒无心跳即判离线并把任务退回队列（同一任务最多换 3 个节点）。等待认领与执行超时可分别配置，超时后可按 `OPENCOXSWAIN_REMOTE_FALLBACK` 回退本地运行时。节点用 `node dist/remote-agent.js --daemon <url> --token <令牌> --name <名称>` 启动，只需能出站访问 daemon，无需在本地开端口。设置页「远程节点」可在界面里开启 / 关闭远程执行、复制接入令牌、查看节点在线状态与最近心跳、移除节点，以及看到排队中与执行中的远程任务。

未实现（按计划在后续阶段接入）：

- 云端执行、团队共享记忆、远程插件市场（条件触发）。

## 运行时与 Planner 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCOXSWAIN_DEFAULT_RUNTIME` | `mock` | 任务默认可执行体：`mock` / `opencode` / `remote` |
| `OPENCOXSWAIN_OPENCODE_BIN` | 自动发现 | OpenCode CLI 路径；默认找桌面版 `opencode-cli.exe` |
| `OPENCOXSWAIN_DEFAULT_MODEL` | 空 | 覆盖角色默认模型，如 `provider/model` |
| `OPENCOXSWAIN_LLM_API_KEY` / `DEEPSEEK_API_KEY` | 空 | Planner 的 API Key；DPAPI 仓库未命中时回退到这两个变量 |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | Planner 模型 |
| `OPENCOXSWAIN_NODE_BIN` | 空 | 桌面壳启动 daemon 用的 Node；安装包默认用自带运行时，开发态可指向自己的 node.exe |
| `OPENCOXSWAIN_HOST` | `127.0.0.1` | daemon 监听地址；远程节点接入时设 `0.0.0.0` 或内网地址 |
| `OPENCOXSWAIN_REMOTE_CLAIM_MS` | `45000` | 等待远程节点认领的超时 |
| `OPENCOXSWAIN_REMOTE_JOB_MS` | `1800000` | 远程任务执行超时 |
| `OPENCOXSWAIN_REMOTE_FALLBACK` | 空 | 远程不可用/超时后回退的本地运行时（如 `mock`、`opencode`） |

OpenCode 桌面版 CLI 的实测结论、坑与替代路线见 [docs/spike-opencode.md](docs/spike-opencode.md)。

密钥推荐写入 DPAPI 仓库（按当前 Windows 用户加密，明文不落盘）：

```bash
curl -X PUT http://127.0.0.1:47821/api/secrets/llm \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-..."}'
curl http://127.0.0.1:47821/api/secrets
```

`GET /api/secrets` 只返回来源（`vault` / `env` / `none`）与后端类型，不返回密钥。删除用 `DELETE /api/secrets/llm`。

## 自动更新

桌面壳内置 Tauri Updater，但发布地址与签名公钥因部署环境而异，且私钥绝不能进仓库，所以两者都放在目标机器上，不写进 `tauri.conf.json`。

1. 生成签名密钥（只做一次，私钥离线保存、不要提交）：

   ```powershell
   pnpm --filter @opencoxswain/desktop tauri signer generate -w $env:USERPROFILE\.opencoxswain\updater.key
   ```

   会得到 `updater.key`（私钥）与 `updater.key.pub`（公钥）。发布时设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容或路径）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，执行 `pnpm desktop:release`，除 NSIS 安装包外还会产出同名 `.sig`（自动更新的签名）。

   `src-tauri/tauri.release.json` 里的 `pubkey` 只是给打包器用的占位示例值（对应私钥未入库），应用实际校验用的公钥来自下面的 `updater.json`，两者不需要一致。

2. 把安装包与 `latest.json` 放到任意 HTTPS 静态地址。`latest.json` 的 `platforms.windows-x86_64.url` 指向安装包，`signature` 填 `.sig` 的内容。

3. 在目标机器写入 `%LOCALAPPDATA%\OpenCoxswain\updater.json`，重启应用后设置页即可检查更新：

   ```json
   {
     "endpoint": "https://example.com/opencoxswain/latest.json",
     "pubkey": "updater.key.pub 的内容"
   }
   ```

   开发时可用 `OPENCOXSWAIN_UPDATER_ENDPOINT` / `OPENCOXSWAIN_UPDATER_PUBKEY` 临时覆盖。未配置时设置页只显示当前版本，不会发起网络请求。

## 文档

- [PRD 原文](docs/prd/OpenCoxswain-PRD.tex)
- [实施计划](docs/plan.md)
- [插件架构](docs/plugin-architecture.md)
- [OpenCode Spike](docs/spike-opencode.md)

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
