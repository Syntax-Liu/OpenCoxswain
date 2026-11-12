# 术语表（Glossary）

> 本文是**命名的唯一权威来源**。代码、文档、界面、提交信息一律以此为准。
>
> 早期用 A/B/C/D 作为口述代号（方便记忆），**现已废弃**。
> 后来还短暂用过 General Manager / Project Manager，也已改为现在的叫法。

---

## 四个角色

| 代号 | 正式名称 | 中文 | 一句话职责 |
| --- | --- | --- | --- |
| **A** | **User** | 用户 | 说出要做什么，对不可逆的事拍板 |
| **B** | **Supervisor** | 总管 | **跨项目**的全局统筹：看得见所有项目的进度与冲突 |
| **C** | **Assistant** | 助理 | 一个项目一个，常驻；派活给 Agent、汇总、汇报 |
| **D** | **Agent** | Agent | 临时工，干一件具体的事，干完结算 |

### 为什么这么叫

| 名称 | 业内对应 | 说明 |
| --- | --- | --- |
| User | 通用 | 无需解释 |
| Supervisor | Supervisor（多智能体架构里最通用的说法） | 监督、裁决、管全局 |
| Assistant | AI Assistant | 用户直接对话的对象 |
| Agent | Subagent / Worker / Executor | 业内最通用；Claude Code 叫 subagent，OpenAI 叫 worker |

**Supervisor 与 Assistant 的区别**（早期设计里这一点是模糊的）：

- **Assistant 只看自己那个项目**。它不知道别的项目在干什么，也不需要知道。
- **Supervisor 只关心项目之间**。它不插手任何单个项目的具体执行。

---

## 写法规范

**文案必须一律用英文且首字母大写**：User / Supervisor / Assistant / Agent。

**中文不翻译**——界面上直接显示 Supervisor / Assistant / Agent，不使用「总管 / 助理 / 执行者」这类中文说法。

- ✅ "Assistant 正在派活"
- ❌ "assistant 正在派活"
- ✅ 界面标签：「C · Assistant」
- ❌ 界面标签：「C · 助理」

中文可以简称：总管（Supervisor）/ 助理（Assistant）/ Agent，
但**正式名称一律用英文**。

---

## 术语对照（代码 / 界面 / 文档）

| 概念 | 代码标识符 | 界面文案 | 文档用词 |
| --- | --- | --- | --- |
| 用户 | `user` | 你 | User |
| 总管 | `generalManager`（历史名，语义为 Supervisor） | Supervisor | Supervisor |
| 助理 | `assistant` | Assistant | Assistant |
| Agent | `executor`（历史名，语义为 Agent） | Agent | Agent |

### 代码里的命名约束

- **新代码**一律用 `supervisor` / `assistant` / `agent`。
- **存量代码**的 `generalManager` / `executor` 是历史名称，等价于 `supervisor` / `agent`，
  已在下方对照表中登记，逐步迁移，**不要因为改名引入行为变化**。

| 历史标识符 | 现在等价于 | 出现位置 |
| --- | --- | --- |
| `generalManager` / `global/*` | Supervisor | `src/global/` |
| `assistant` / `AssistantSession` | Assistant | `src/assistant/` |
| `executor` / `ExecutorRow` | Agent | `src/executor/` |
| `assistantSessionId` | Assistant 的会话 | `project` 表 |
| `executorId` | Agent 的 id | 多处 |

> 数据表字段（`assistant_session_id`、`executor`）**保持原名**：
> 数据库迁移风险高、收益低。语义上按本表理解即可。

---

## 容易混淆的地方

### Supervisor 不是"转接员"

最早 Supervisor 只有"找项目 + 转交原话"两个功能，和 Assistant 高度重复。
现在它的职责是**跨项目的四件事**，详见 [`architecture.md`](architecture.md)：

1. 跨项目全局视图
2. 跨项目冲突检测
3. 优先级裁决
4. 跨项目记忆

### Agent 不是"通用智能体"

Agent 只有 5 个固定工具（读、写、列目录、搜文件、执行命令），
是**短期、单一职责**的Agent，不是能自主规划的通用智能体。

---

## 使用规则

1. **对外一律用正式名称且首字母大写**：User / Supervisor / Assistant / Agent。
2. **代码标识符按上表**，新代码不得再引入 `generalManager` / `executor` 作为新名称。
3. **A/B/C/D 只在需要极简指代时使用**（如表格表头），且首次出现要标注全称。
