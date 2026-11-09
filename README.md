# OpenCoxswain · 舵手

本地优先的 Windows AI 总管。你只对总管说话；总管把目标拆成结构化任务单和 DAG，派给在独立 git worktree 里干活的 AI 员工，盯进度、做验收，最后按固定三块汇报：待你决策 / 未通过的检查 / 交付产物。

当前版本 `0.1.0`，处于实施计划的 P0：可运行纵切与工程骨架。

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

## 目录

```
apps/
  daemon/      # 本地核心：HTTP/SSE、SQLite、调度器、总管编排、worktree
  desktop/     # React 18 + TypeScript + Vite 工作台（P1 加 Tauri 2 壳）
packages/
  shared/      # ID、时间、领域类型与 API DTO
  core/        # 任务契约、状态机、DAG、预算、汇总、工具白名单
  adapters/    # RuntimeAdapter 接口 + Mock 运行时
docs/
  prd/         # PRD 原文（tex + pdf）
  plan.md      # 分阶段实施计划与取舍
```

## P0 能力边界

已实现：

- 任务单校验、状态机、DAG 依赖、写域冲突、预算守卫、三块汇总。
- SQLite 持久化（`node:sqlite`），事件 append-only，可回放、可导出。
- 每任务独立 worktree 与分支；调度器按依赖/并发/写域派发。
- 审批开工、打回、暂停/继续/终止、验收。
- Mock 运行时：真实写文件、跑验收命令、产出 diff 与报告，离线可跑。
- 浏览器工作台：对话、任务树、员工看板、时间线、产物、汇总、花费、设置。

未实现（按计划在 P1+ 接入）：

- OpenCode 运行时、LLM Planner、真实模型 BYOK。
- Tauri 2 桌面壳与安装包。
- 记忆层、多项目、IM 入口。

## 文档

- [PRD 原文](docs/prd/OpenCoxswain-PRD.tex)
- [实施计划](docs/plan.md)

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
