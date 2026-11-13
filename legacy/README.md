# 遗留代码（已归档）

> 归档于 2026-11-13（v0.68.0）
> **这些代码不参与构建、不参与类型检查、不被当前产品引用。**

---

## 为什么归档

当前产品是 `apps/runtime` + `apps/shell` + `apps/web` 三件套，
**零第三方依赖**的 Agent 运行时 + Tauri 桌面壳 + 工作台界面。

而这里的东西是**旧架构**：

| 目录 | 是什么 |
| --- | --- |
| `daemon/` | 早期基于 HTTP 服务的 Agent 守护进程 |
| `desktop/` | 早期 Electron 桌面壳 |
| `adapters/` | OpenCode 等外部 Agent 的适配层 |
| `core/` | legacy 内核 |
| `memory/` | 早期记忆实现 |
| `shared/` | 公共类型 |
| `plugin-api/` | 插件 API（未落地） |

**约 28892 行。** 比当前运行时（23858 行）还多。

---

## 为什么是归档而不是删除

1. **里面有有价值的设计**：`daemon` 是一套完整的多 Agent 实现，
   有些思路（任务队列、状态机）比现在更成熟
2. **可追溯到历史决策**：想知道"当初为什么那么做"时能查
3. **随时能捡回来**：真需要某个模块时，搬回 `apps/` 或 `packages/` 即可

删掉的话，这些都没了。

---

## 归档时做了什么

- 从 `apps/` 和 `packages/` 移到 `legacy/`
- `pnpm-workspace.yaml` **不包含** `legacy/*`，所以不参与构建
- `package.json` 的 `typecheck` 只查 `runtime` / `web` / `shell`
- 保留 `typecheck:legacy` 脚本，需要时可单独检查（但**不保证能过**）

---

## 确认过的事

归档前验证：

- 新架构（runtime / web / shell）**零引用**这里的任何代码
- `pnpm test` 1076 条通过
- `pnpm typecheck` 正常
- E2E 套件 10 步全过

---

## 如果要把某个模块捡回来

1. 把目录移回 `apps/` 或 `packages/`
2. 在 `pnpm-workspace.yaml` 里它已被 `apps/*` / `packages/*` 覆盖，不用改
3. 检查它的依赖是否还在（可能引用了其它 legacy 包）
4. 补测试——这些代码**当前没有任何测试覆盖**

---

## 一个判断

这些代码当初是我（AI）在早期架构下写的，后来产品方向变成
"零依赖自研"，它们就被架空了。

**不是它们写得不好，是方向变了。**

留档而不是删掉，也是这个原因。
