# @opencoxswain/runtime

**自研运行时（产品本体）**。不依赖 dsh、TRAE 或任何外部 Agent 框架，只依赖 Node.js 内置能力与一个 OpenAI 兼容的模型端点。

## 四层结构

```
A 用户 ──┬─→ B 全局助理   路由 + 转交原话，不执行
         ├─→ C 项目助理   一项目一常驻会话，主推入口
         └─→ D 执行者     一事一 D，直接改代码，可追问
```

## 快速跑起来

```bash
pnpm --filter @opencoxswain/runtime build

export OPENCOXSWAIN_LLM_API_KEY=sk-...                          # 必需（也可在界面里填）
export OPENCOXSWAIN_LLM_BASE_URL=https://api.deepseek.com/v1    # 可选
export OPENCOXSWAIN_LLM_MODEL=deepseek-chat                     # 可选
export OPENCOXSWAIN_DB=%USERPROFILE%/.opencoxswain/runtime.db   # 可选，默认就是这里

# 命令行交互
node apps/runtime/dist/cli.js --project D:/work/my-app

# 只起服务（桌面壳 / 界面用）
node apps/runtime/dist/cli.js --serve --static apps/web/dist
```

进入后直接对 C 说话即可。可以连发，不会被打断。
关掉再打开，C 会带着完整对话上下文继续。

## 目录

```
src/
  index.ts              对外导出
  cli.ts                独立运行入口（--serve / --static / --project）
  orchestrator.ts       编排核心：C ↔ D 的全部粘合逻辑
  assistant/
    session.ts          C 的常驻会话句柄 + 冲突判定
    prompt.ts           C 的提示词与 7 个工具定义
  executor/
    executor.ts         D 的运行循环、文件工具、卡点分类、只读拦截
    gate.ts             并发闸门 + 写域互斥（区分只读/读写/未声明）
  session/
    loop.ts             LLM tool-calling 循环（通用 Agent 核心）
  inbox/
    inbox.ts            连发不打断队列（含内部通知标记）
  server/
    server.ts           HTTP + SSE 接口 + 静态资源
    bus.ts              可重放事件总线
  memory/
    gate.ts             记忆写入门槛
    search.ts           中文二元组分词 + 混合排序
    store.ts            Markdown 存储（全局 / 项目两级）
  llm/
    types.ts            LLM 抽象 + OpenAI 兼容实现
    settings.ts         密钥保管（环境变量 > 本地文件）+ 运行时热切换
  store/
    store.ts            Store 接口 + 内存实现
    sqlite.ts           SQLite 实现（node:sqlite）
  global/
    assistant.ts        B 的路由与转交
  test/                 199 条测试
```

## 关键机制

### 1. C 是一项目一常驻会话

同一路径永远得到同一个 `assistantSessionId`。C 的记忆 = 会话历史 + 项目记忆文件。

### 2. 连发不打断

| 队列 | 语义 | 用在哪 |
| --- | --- | --- |
| `next` | 当前轮结束后单独开一轮 | **用户连发的默认** |
| `step` | 插到当前轮的下一个工具步之前 | 「等等，改一下」 |

新消息只进队列，**永远不会在中途插入当前轮**。

### 3. D 的三种访问形态（决定并行度）

这是并行是否真的成立的关键。早期版本把「只读」和「没声明写域」混为一谈，
导致三条本该并行的只读任务被逐条串行。

| 形态 | 判定 | 能否并行 |
| --- | --- | --- |
| `readonly` | `writeScope: ["readonly"]` | ✅ 与任何人并行，包括其它只读 |
| 有写域 | `writeScope: ["src/auth"]` | 与**相交**的写任务串行 |
| 未声明 | `writeScope: []` | ❌ 与所有写任务串行（最坏假设） |

**只读任务有工具层硬拦截**：`write_file` 直接拒绝；`run_command` 挡掉
`rm` / `Set-Content` / `git commit` / 重定向写入等修改型命令。
光在提示词里说「别写」不够——这是真保证。

### 4. 先完成先汇报

每个 D 结算时**独立**触发一次汇报，不等兄弟。同一批几乎同时完成的，
在 `reportDebounceMs`（默认 800ms）窗口内合并成一条。

### 5. 卡点三分类

| 分类 | 判定依据 | C 该怎么做 |
| --- | --- | --- |
| 可自行重试 | 类型错误 / 测试失败 / 改错路径 | 换法重试，**不打扰用户** |
| 环境问题 | ENOENT / EPERM / 缺依赖 / 端口占用 | 如实报告 + 修复建议 |
| 需用户决定 | 其余（保守归类） | 收敛成**一个**具体问题 |

### 6. D 可以续聊

D 完成后用户仍可对它追问，它**带着原上下文**继续：

- 建 D 会话时存下 `systemPrompt` 与首轮目标；
- 续聊时把历史消息作为 `priorMessages` 重新传入（不再是「请开始执行」）；
- 只读 D 仍然只读，写域限制不变——不能借续聊越权；
- 续聊产生的结论进 D 轨迹，并落一条汇报给 C（D3：C 要知情）。

### 7. 持久化与重启恢复（D5）

用 Node 内置的 `node:sqlite`，**不需要编译原生模块**。默认库在 `~/.opencoxswain/runtime.db`。

**同一套断言跑两个后端**（`MemoryStore` / `SqliteStore`），保证换后端不改变行为。

重启时 `recover()` 做两件事：

| 情况 | 处理 |
| --- | --- |
| 上次进程被中断时仍在跑的执行者 | **如实标记为失败**。**不会**悄悄放回队列自动重跑——那会在用户不知情下重复执行副作用 |
| 项目与 C 的会话历史 | 重新打开项目时挂回同一个 `assistantSessionId` |

Schema 用 `PRAGMA user_version` 做迁移（当前 v2：`executor` 表新增 `access` 列）。

### 8. HTTP / SSE 服务层

`--serve` 启动后提供 REST + SSE。**默认只监听 127.0.0.1**。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 统计 + 当前 `lastSeq` |
| GET / POST | `/api/settings` | 模型密钥状态 / 保存（**保存后立即生效**） |
| DELETE | `/api/settings` | 清除密钥 |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 打开/新建项目 |
| GET | `/api/projects/:id` | 项目详情（执行者 + 汇报） |
| GET | `/api/projects/:id/messages` | C 的对话历史（**内部通知带 `internal: true`**） |
| POST | `/api/projects/:id/say` | 对 C 说话（**202 立刻返回**） |
| POST | `/api/projects/:id/stop` | 停止 C 当前轮 |
| GET | `/api/executors/:id/messages` | **打开原会话**：D 的完整轨迹 |
| POST | `/api/executors/:id/say` | **用户直接追问 D**（带上下文续跑） |
| POST | `/api/executors/:id/cancel` | 取消执行者 |
| POST | `/api/route` | B 的路由判断 |
| POST | `/api/handoff` | B 转交原话 |
| GET | `/api/events?after=seq` | SSE 事件流 |

**SSE 的三个关键点**：

1. **立刻 `flushHeaders()`**。不这么做，客户端 `fetch()` 会卡到超时（实测 15s）才拿到响应头。
2. **断线可重放**。每个事件带单调 `seq`，客户端重连带 `?after=` 补发错过的；错过太多返回 `gap` 事件让客户端重拉快照。
3. **静态资源用 `no-cache` + `ETag`，不用长缓存**。早期给 assets 设了 `immutable`（一年），结果桌面应用升级后 webview 仍加载旧 JS——"修了却没生效"排查了半天。

### 9. 记忆层

布局完全对齐 TRAE 宝（本地 Markdown，**用户可直接打开编辑**）：

| 类型 | 位置 | 注入方式 |
| --- | --- | --- |
| 全局记忆 | `~/.opencoxswain/memory/user_profile.md` | 按这句话的相关性检索 |
| 项目记忆 | `~/.opencoxswain/memory/projects/{key}/project_memory.md` | **全量注入**（规则是硬约束） |

**写入门槛**（对齐 TRAE 宝「不会被保存为记忆的信息」）：

| 拒绝 | 例子 |
| --- | --- |
| 临时指令 | 「这次先用 axios」 |
| 模糊偏好 | 「可能以后都这样吧」 |
| 疑似密钥 | `apiKey: sk-...` |
| 过短 / 无来源 | 「好」 |

被拒绝时**如实告诉模型**原因，而不是静默丢弃——否则它会以为自己记住了。

C 有两个记忆工具：`remember` / `search_memory`。检索用中文二元组 + 时间衰减混合排序（不做 embedding）。

### 10. 内部通知不污染对话流
执行者结算通知**进 C 的上下文**（否则 C 不知道该汇报），但：

- 存储时 `source` 记为 `internal:executor`；
- 接口返回时带 `internal: true`；
- 界面据此**不显示在对话流里**。

早期版本把整块 `【执行者结算】` + D 的原始输出 + `请立刻向用户汇报这一条结果`
都渲染给了用户，那是明确的泄漏。

### 11. 运行指标与用量止损（**不做计费**）

**刻意不估算金额**。不同模型单价不同、厂商随时调整、软件离线无法获取实时价格，
而且用户本来就能在服务商后台看到真实账单——估出来的数只会误导人。

只记录**模型自己报告**的真实数字：

| 指标 | 来源 |
| --- | --- |
| 轮次 | 一次 `llm.chat` = 一轮 |
| 步数 | 工具调用次数 |
| token 入/出 | `usage.prompt_tokens` / `completion_tokens` |
| 缓存命中 | `prompt_cache_hit_tokens` 或 `prompt_tokens_details.cached_tokens`；**没报告时为 null 而不是 0** |
| 耗时 / 上下文占用 | 本地计时；最后一轮的 prompt_tokens |

**`tokenGuard`（用量止损线，不是预算）**：

- `perTask`：单个执行者上限；`perDay`：项目每日上限；
- 运行中每轮检查，超标**立即 `abort()`**，落「待决策」汇报写明"这是止损线"；
- 派活前检查日上限，超了**直接拒绝**而不是排队（排队会让用户以为等会儿能跑）。

为什么保留止损线：token 是真实数字，不需要任何假设。失控的执行者
（死循环、反复重试）可能在几分钟内烧掉大量额度。

```bash
# 查询用量
GET  /api/projects/:id/usage
# 设置止损上限
POST /api/projects/:id/guard   { "perTask": 200000, "perDay": 2000000 }
```

## 测试

```bash
pnpm --filter @opencoxswain/runtime build
pnpm --filter @opencoxswain/runtime test
```

**199 条测试**，全部用脚本化假模型（`MockLlmClient`）驱动，不需要网络：

| 文件 | 条数 | 覆盖 |
| --- | --- | --- |
| `server.test.ts` | 18 | HTTP 接口、SSE 首帧、断线重放、gap、CORS、超大 body |
| `memory.test.ts` | 17 | 写入门槛、分词排序、Markdown 往返、跨会话生效 |
| `ledger.test.ts` | 17 | **执行前落 pending**、被拒绝记 rejected、读操作不记账 |
| `extract.test.ts` | 16 | **临时指令进不了候选**、候选不自动生效、拒绝过的不再提 |
| `acceptance.test.ts` | 17 | **D 声称完成但没改动 → 判失败**、复核命令过闸门、失败不可覆盖 |
| `guard.test.ts` | 16 | **用量止损真的能停下来**、指标格式化、未报告≠0 |
| `runtime.test.ts` | 15 | 主推流程端到端、并行、排队、先完成先报、连发 |
| `parallel.test.ts` | 15 | **只读任务真正并行**、写任务仍互斥、只读命令拦截 |
| `store.test.ts` | 14 | **同一套断言跑内存与 SQLite** |
| `approval.test.ts` | 14 | **未批准的动作真的没发生**、超时自动拒绝、不误伤安全命令 |
| `static.test.ts` | 10 | 静态资源、路径穿越防护、**缓存策略回归** |
| `llm-settings.test.ts` | 9 | 密钥保管、环境变量优先、保存后立即生效 |
| `path.test.ts` | 7 | 盘符根归一化（`D:\` → `d:/`，回归 EISDIR） |
| `dchat.test.ts` | 5 | 三条只读并行、**D 可续聊** |
| `purity.test.ts` | 5 | 内部通知不进对话流 |
| `recover.test.ts` | 3 | 关掉再打开，C 带着上次的对话继续 |
| `probe.test.ts` | 1 | SSE 首帧延迟回归守卫 |

HTTP 层测试**真的起端口并用 `fetch` 打过去**；记忆测试**真的读写临时目录里的 `.md` 文件**；
存储测试**真的开 SQLite 文件**。

## 与 legacy 的关系

| 资产 | 用法 |
| --- | --- |
| `packages/adapters/builtin.ts` 的 tool-calling 循环 | 提炼成 `session/loop.ts`，去掉任务契约/worktree 耦合 |
| `packages/dsh-bao` 的 gate/judge/inbox/reporter | 纯逻辑移植，行为由两侧测试共同钉死 |
| `packages/core`、`packages/memory` | 记忆写入门槛/检索、用量止损、危险动作分类、验收策略已移植；**副作用台账尚未接入** |

`packages/dsh-bao` 已**冻结**为设计参考，不再演进。

## 尚未实现

| 项 | 说明 |
| --- | --- |
| 任务模板 / 定时任务 | 设计已明确（legacy 有），未移植 |
| IM 通道 | 飞书 / Telegram 未接入 |
| 自动更新 | 桌面壳尚未实现 |

后续发展方向见 [`docs/roadmap.md`](../../docs/roadmap.md)。
