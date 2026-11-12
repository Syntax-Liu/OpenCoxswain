# 术语表（Glossary）

> 本文是**命名的唯一权威来源**。代码、文档、界面、提交信息一律以此为准。
>
> 早期用 A/B/C/D 作为临时代号（口述方便），**现已废弃**。
> 旧文档里看到 A/B/C/D 时请对照本表。

---

## 四个角色

| 代号 | 正式名称 | 中文 | 一句话职责 |
| --- | --- | --- | --- |
| **A** | **User** | 用户 | 说出要做什么，对不可逆的事拍板 |
| **B** | **General Manager** | 总经理 | **跨项目**的全局统筹：看得见所有项目的进度与冲突 |
| **C** | **Project Manager** | 项目经理 | 一个项目一个，常驻；派活给 Agent、汇总、汇报 |
| **D** | **Agent** | 执行者 | 临时工，干一件具体的事，干完结算 |

### 为什么这么叫

| 名称 | 业内对应 | 说明 |
| --- | --- | --- |
| User | 通用 | 无需解释 |
| General Manager | Supervisor / Orchestrator（全局层） | 管全局、管资源、管跨项目冲突 |
| Project Manager | Assistant / Orchestrator（项目层） | 管一个项目的全部事务 |
| Agent | Subagent / Worker / Executor | 业内最通用；Claude Code 叫 subagent，OpenAI 叫 worker |

**注意 B 与 C 的区别**（早期设计里这一点是模糊的）：

- **C 只看自己那个项目**。它不知道别的项目在干什么，也不需要知道。
- **B 只关心项目之间**。它不插手任何单个项目的具体执行。

---

## 术语对照（代码 / 界面 / 文档）

| 概念 | 代码标识符 | 界面文案 | 文档用词 |
| --- | --- | --- | --- |
| 用户 | `user` | 你 | User |
| 总经理 | `generalManager` | 总经理 | General Manager |
| 项目经理 | `projectManager` | 项目经理 | Project Manager |
| 执行者 | `agent` | 执行者 | Agent |

### 代码里的命名约束

- **新代码**一律用 `generalManager` / `projectManager` / `agent`。
- **存量代码**的 `assistant` / `executor` 是历史名称，等价于 `projectManager` / `agent`，
  已在下方对照表中登记，逐步迁移，**不要因为改名引入行为变化**。

| 历史标识符 | 现在等价于 | 出现位置 |
| --- | --- | --- |
| `assistant` / `AssistantSession` | Project Manager | `src/assistant/` |
| `executor` / `ExecutorRow` | Agent | `src/executor/` |
| `assistantSessionId` | Project Manager 的会话 | `project` 表 |
| `executorId` | Agent 的 id | 多处 |

> 数据表字段（`assistant_session_id`、`executor`）**保持原名**：
> 数据库迁移风险高、收益低。语义上按本表理解即可。

---

## 容易混淆的地方

### "助理"这个词要避免

早期叫"项目助理"，但 **assistant 在业内泛指一切 AI**，容易和"Agent"混。
现在统一为**项目经理（Project Manager）**——它做的事（派活、汇总、判断冲突）
确实就是项目经理。

### B 不是"转接员"

早期 B 只有"找项目 + 转交原话"两个功能，和 C 高度重复。
现在 B 的职责是**跨项目的四件事**，详见 [`architecture.md`](architecture.md)：

1. 跨项目全局视图
2. 跨项目冲突检测
3. 优先级裁决
4. 跨项目记忆

### D 不是"智能体"的泛称

D 只有 5 个固定工具（读、写、列目录、搜文件、执行命令），
是**短期、单一职责**的执行者，不是能自主规划的通用智能体。

---

## 使用规则

1. **对外一律用正式名称**：文档、界面、提交信息、发布说明。
2. **代码标识符按上表**，新代码不得再引入 `assistant` / `executor` 作为新名称。
3. **A/B/C/D 只在需要极简指代时使用**（如表格表头），且首次出现要标注全称。
