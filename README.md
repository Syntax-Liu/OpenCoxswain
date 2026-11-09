# OpenCoxswain · 舵手

本地优先的 Windows AI 总管。你只对总管说话；总管把目标拆成结构化任务单和 DAG，派给在独立 git worktree 里干活的 AI 员工，盯进度、做验收，最后按固定三块汇报：待你决策 / 未通过的检查 / 交付产物。

当前版本 `0.7.0`，处于实施计划的 P3：插件化内核、OpenCode 运行时与 LLM Planner 已就绪，预算硬停、危险动作人审、DPAPI 密钥托管、失败重试、冲突转人审、成本报表与回放导出已接入；员工角色已改为可安装插件包，验收改为系统复核 + 逐条人工决策，桌面壳待接入。

## 快速开始

要求：

- Node.js >= 22（使用内置 `node:sqlite`，无需编译原生模块）
- pnpm >= 9

```bash
pnpm install
pnpm dev
```

- 工作台：http://127.0.0.1:5173
- Daemon：http://127.0.0.1:47821（仅监听本机）

首次打开时填入一个已存在的 git 仓库路径，对总管描述目标，确认任务单后即可看到实施/校验两个员工在各自 worktree 中执行。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 构建并同时启动 Daemon 与 Vite 工作台 |
| `pnpm build` | 构建全部 workspace 包与工作台静态资源 |
| `pnpm typecheck` | 全仓 TypeScript 严格检查 |
| `pnpm test` | core 单元测试 + daemon 端到端集成测试 |
| `pnpm e2e` | 独立跑一遍 v0 剧本并打印进度 |
| `pnpm e2e:opencode` | 可选：用本机 OpenCode CLI 跑真实员工链路（未安装时跳过） |

## 目录

```
apps/
  daemon/      # 本地核心：HTTP/SSE、SQLite、调度器、总管编排、worktree
  desktop/     # React 18 + TypeScript + Vite 工作台（桌面壳在后续阶段接入）
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

## 当前能力（v0.7.0）

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
- 员工插件包：角色 + 技能 + 工具白名单 + 权限 + 默认验收标准五件套由插件注册；调研员/实施员/校验员/撰写员均走同一加载路径，`GET /api/employees` 可查看已安装员工，调度器与 Planner 不再内置角色。
- 验收自证：员工自报只作审计；`command` 验收由系统在 worktree 内独立重跑，`diff` 用 git 复算，`rubric` / `human` 一律留给人。
- 逐条验收：`POST /api/tasks/:id/acceptance` 要求每个未通过验收项单独给结论和理由，缺结论返回 409、缺理由返回 400；不再有「一键全部通过」入口。
- 验收留痕：evidence 与 acceptance_records 落库，记录交付物、证据摘要、验收标准、验收人（系统/人）与结论，可回放。
- 阶段视图：`GET /api/tasks?stage=person|working|idle` 与工作台「在等谁」标签，明确当前是等人、等依赖还是执行中。
- Mock 运行时：真实写文件、跑验收命令、产出 diff 与报告，离线可跑。
- OpenCode 运行时：调用桌面版 CLI 执行真实任务，JSONL 事件映射、会话隔离、进程树终止。
- LLM Planner：OpenAI 兼容端点，BYO Key；无 Key 自动回退静态拆分。
- 浏览器工作台：对话、任务树、员工看板、时间线、产物、汇总、花费、设置。

未实现（按计划在后续阶段接入）：

- Tauri 2 桌面壳与安装包。
- 记忆层、多项目、IM 入口。

## 运行时与 Planner 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCOXSWAIN_DEFAULT_RUNTIME` | `mock` | 任务默认可执行体：`mock` / `opencode` |
| `OPENCOXSWAIN_OPENCODE_BIN` | 自动发现 | OpenCode CLI 路径；默认找桌面版 `opencode-cli.exe` |
| `OPENCOXSWAIN_DEFAULT_MODEL` | 空 | 覆盖角色默认模型，如 `provider/model` |
| `OPENCOXSWAIN_LLM_API_KEY` / `DEEPSEEK_API_KEY` | 空 | Planner 的 API Key；DPAPI 仓库未命中时回退到这两个变量 |
| `OPENCOXSWAIN_LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `OPENCOXSWAIN_LLM_MODEL` | `deepseek-chat` | Planner 模型 |

OpenCode 桌面版 CLI 的实测结论、坑与替代路线见 [docs/spike-opencode.md](docs/spike-opencode.md)。

密钥推荐写入 DPAPI 仓库（按当前 Windows 用户加密，明文不落盘）：

```bash
curl -X PUT http://127.0.0.1:47821/api/secrets/llm \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-..."}'
curl http://127.0.0.1:47821/api/secrets
```

`GET /api/secrets` 只返回来源（`vault` / `env` / `none`）与后端类型，不返回密钥。删除用 `DELETE /api/secrets/llm`。

## 文档

- [PRD 原文](docs/prd/OpenCoxswain-PRD.tex)
- [实施计划](docs/plan.md)
- [插件架构](docs/plugin-architecture.md)
- [OpenCode Spike](docs/spike-opencode.md)

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
