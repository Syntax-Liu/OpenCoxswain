# 文档索引

> **先看这三份**：项目全貌 → [project-status.md](project-status.md)，
> 现在做到哪 → [status.md](status.md)，命名规则 → [glossary.md](glossary.md)。
> 其余的按需要查。

---

## 一、项目本身

| 文档 | 内容 |
| --- | --- |
| [project-status.md](project-status.md) | **完整快照**：四层结构、功能清单、项目结构、数据模型、API 全清单 |
| [status.md](status.md) | **状态与下一步**：做完了什么、还没做什么、能不能收尾 |
| [architecture.md](architecture.md) | 架构：能力边界与"万物皆插件"的路线 |
| [control-spec.md](control-spec.md) | **控件唯一真相**：`src/ui/` 的组件清单、尺度表、"三件不许做"、怎么验证 |
| [self-developed-plan.md](self-developed-plan.md) | 自研方案原始设计（四层：User / Supervisor / Assistant / Agent） |
| [glossary.md](glossary.md) | **命名唯一权威**：代码、文档、界面、提交信息一律以此为准 |

---

## 二、调研

| 文档 | 内容 |
| --- | --- |
| [research.md](research.md) | **三轮合并**：能力面 6 项 + 交互 5 项 + 多 Agent 2 项 |
| [self-evolution.md](self-evolution.md) | **距自进化还差多少**：半自动/全自动的逐条核对 |
| [guidance-dsh-superagent.md](guidance-dsh-superagent.md) | DSH 团队的设计原则（作为指导方案之一） |

> 调研的结论都直接改成了代码，看"查了什么、修了什么"看 `research.md`。

---

## 三、功能说明（每个都有边界声明）

| 文档 | 内容 | 边界 |
| --- | --- | --- |
| [sandbox.md](sandbox.md) | 命令沙箱 | 静态检查，**非进程隔离** |
| [plan-approval.md](plan-approval.md) | **方案审批与自动推进**（设计，待实现） | **只批一次**：批准后逐步执行不再问；小改动报不停、大改动停并重批 |
| [code-navigation.md](code-navigation.md) | 代码导航 | 词法级，**非真 LSP** |
| [attachments.md](attachments.md) | 附件（拖入/粘贴/选择） | 只做图片和文本文件 |
| [undo.md](undo.md) | 撤销 | **只做文件写入** |
| [skills.md](skills.md) | 技能（SKILL.md） | 按需加载 |
| [mcp.md](mcp.md) | MCP 接入 | 只做 stdio 传输 |
| [extensions.md](extensions.md) | 扩展口 | 不是插件系统 |

---

## 四、界面

| 文档 | 内容 |
| --- | --- |
| [control-spec.md](control-spec.md) | **界面唯一标准**：改界面之前先读它。布局与控件都以它为准 |
| [shortcuts.md](shortcuts.md) | 键盘快捷键 |

---

## 五、方案记录（已完成）

| 文档 | 内容 |
| --- | --- |
| [usability-plan.md](usability-plan.md) | 易用性 9 项（v0.29–v0.34 已完成） |
| [ux-competitive-research.md](ux-competitive-research.md) | **使用体验对标**：同类产品每个操作怎么做、我们差在哪、19 条按优先级排的优化项 |
| [roadmap.md](roadmap.md) | 后续方向与已知技术债（⚠️ 部分内容已过时，以 `next-steps.md` 为准） |
| [next-steps.md](next-steps.md) | **下一步计划**：收口 → 飞书 → 可参与性，含验收标准与待决项 |

---

## 六、工程

| 文档 | 内容 |
| --- | --- |
| [release.md](release.md) | 发布与自动更新（签名、NSIS、latest.json） |
| [open-source-plan.md](open-source-plan.md) | 开源共建方向 |
| [dsh-api-findings.md](dsh-api-findings.md) | DSH API 实证摘录（设计参考） |
| [plugin-architecture.md](plugin-architecture.md) | 插件架构（P1 方向，未实施） |

---

## 七、历史归档 `archive/`

**这些已过时，仅作记录保留。不要按它们做决定。**

| 文档 | 为什么归档 |
| --- | --- |
| `plan.md` | 早期实施计划，已被自研方案取代 |
| `trae-bao-plan.md` / `trae-bao-reference.md` | 对标 TRAE 宝的方案，路线已改为自研 |
| `super-agent-adoption.md` / `market-scan.md` / `competitor-verdict.md` | 早期调研，结论已并入 `research.md` |
| `feasibility-critique-response.md` | 对可行性质疑的回应，已过时 |
| `master-worker-ux.md` | 主从双 Agent UX 分析，已并入实际设计 |
| `questionnaire-v2.md` / `questionnaire-final.md` | 需求验证问卷，未实际发放 |
| `spike-opencode.md` | OpenCode 接入验证，路线已改自研 |
| `dsh-bao-m0.md` | DSH 宝 M0 冻结记录 |
| `design-direction.md` | 设计方向探索过程，结论已在 `control-spec.md` |
| `status-2026-11-12.md` | v0.34 时的收尾快照，已被 `status.md` 取代 |
| `ui-spec.md` / `ui-design-spec.md` | 界面标准的三份旧版本之一、之二。**2026-11-17 起界面标准只有 `control-spec.md`** |
| `ui-consistency-plan.md` | 六轮控件统一的改造记录。改造已完成，结论落成了 `src/ui/` 组件 |
| `ui-redesign-spec.md` | 曾提出"推倒重来"的界面重构方案。**已被否决**（见提交 `18bbf66`：布局是对的，坏在细节打磨） |

---

## 写文档的约定

1. **每个功能文档必须写清边界**——"做不到什么"比"能做什么"更重要
2. **不新增文档**，先问能不能并进现有的
3. **过时就归档**，不要留在主目录里误导人
4. 文档里的数字（测试数、版本号）**改了代码要同步**
