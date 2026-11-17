# Agent 界面设计资料库

> 建于 2026-11-17。
>
> **这里放的是「为什么这么设计」和「别人怎么做的」**，不是操作手册。
> 要动手改界面，先看 [ui-dev-guide.md](../ui-dev-guide.md)。

---

## 这套资料解决什么问题

改造界面时最常卡住的问题不是"不会写 CSS"，而是：

1. **不知道 Agent 界面该长什么样** —— 没有参照，只能凭感觉
2. **不知道别人踩过什么坑** —— 重复发明，重复踩坑
3. **不知道什么值得改** —— 所有地方都觉得该改，结果什么都改不好

这套资料按这三个问题组织。

---

## 文件

| 文件 | 回答什么 | 什么时候看 |
| --- | --- | --- |
| [01-authoritative-guides.md](01-authoritative-guides.md) | **行业权威怎么说**：自主性四级分类、17 条设计原则、9 个 UX 模式、23 种 AI 任务的默认自主级别 | 设计新功能前，确认方向 |
| [02-product-teardowns.md](02-product-teardowns.md) | **热门产品怎么做**：Perplexity / Cursor / Claude Code / v0 / Linear 的拆解 | 找具体做法时 |
| [03-agent-ui-problems.md](03-agent-ui-problems.md) | **Agent 界面最容易出什么问题**：五类 22 个问题，每条有症状/根因/解法/验证 | **最常用**，改之前先查 |
| [04-our-action-items.md](04-our-action-items.md) | **对照本项目该做什么**：资料结论 → 具体文件 → 优先级 | 排期时 |

---

## 与已装 skill 的关系

你装了一个 `desktop-agent-ui` skill（`C:\Users\37632\.dsh\skills\desktop-agent-ui`），
它已经覆盖得很完整：

- **17 条工程机制**（ENG-01~17）：阴影裁切、滚动槽位、CJK 输入法守卫、骨架屏、View Transitions、裁切审计脚本…
- **12 条视觉铁律**：禁中点分隔符、0.5px 边框、字号 ≤4 档、同心圆角、等宽数字…

**这套资料不重复它。** 分工是：

| | desktop-agent-ui skill | 这套资料 |
| --- | --- | --- |
| 性质 | 施工规范 | 设计决策依据 |
| 解决 | **怎么做对** | **做什么、为什么** |
| 内容 | 工程机制、避坑、验收脚本 | 行业研究、产品拆解、问题清单 |
| 冲突时 | **以 skill 为准**（它针对本项目技术栈调过） | — |

唯一有重叠的是 [03](03-agent-ui-problems.md) 的状态呈现部分——但 skill 讲的是"RICH 控制权"这个抽象框架，
这里讲的是"七个运行状态具体画成什么样、用什么措辞"。

---

## 三个核心结论（先记住这三条）

### 1. 别用"加载中/完成"两态模型

经典请求只有两个可见状态。Agent 运行有**至少七个**：

```
已接收 → 思考 → 工具调用 → 等待批准 → 流式输出 → 完成 → (失败/停止)
```

每个状态的**外观和文字都应该不同**，而不是一个转圈。

> 来源：[Agentic UI 状态](https://www.exodeui.com/zh-cn/learn/agentic-ui-states/) —— 原文：
> "我们看到的最常见的错误是整个运行过程中只使用了一个旋转器。
> 它隐藏了代理正在做实际工作的事实，因此人们认为它被卡住并刷新。"

### 2. 自主性不是二元开关

Anthropic/CMU 的分类法把 Agent 自主性分四级：

| 级别 | Agent 做什么 | 人做什么 |
| --- | --- | --- |
| **L1 观察建议** | 只监控、报警 | 所有决策 |
| **L2 计划提议** | 出方案，等人批 | 审方案、改步骤 |
| **L3 行动确认** | 准备好，等一个 go | 确认或取消 |
| **L4 自主执行** | 在边界内自己干 | 设边界、看历史、处理异常 |

**同一个产品里，不同任务应该在不同级别。** 让用户能逐任务调节，
而不是全局一个"AI 模式"。

> 来源：AI Design Principles v1.1（2026），改编自 SAE J3016 自动驾驶分级

### 3. 十秒是分界线

Nielsen Norman Group 的响应时间研究：

- **0.1 秒** —— 感觉是瞬间的
- **1 秒** —— 思路不中断
- **10 秒** —— 超过这个，人必须知道"在做什么、大概还要多久"

Agent 运行几乎必然超过 10 秒。**所以状态播报不是可选项。**

---

## 阅读建议

**第一次读**：只读上面三个结论 + [03 的问题清单](03-agent-ui-problems.md)的目录。

**准备改某个组件**：直接查 [03](03-agent-ui-problems.md) 对应章节 → [04](04-our-action-items.md) 看本项目该改什么 → [ui-dev-guide.md](../ui-dev-guide.md) 看怎么改。

**要设计新功能**：读 [01](01-authoritative-guides.md) 定自主性级别和 UX 模式，再看 [02](02-product-teardowns.md) 找参考。

---

## 来源清单

所有资料均实际抓取核实内容，标注了日期与版本。

### 英文

| 资料 | 类型 | 日期 |
| --- | --- | --- |
| [AI Design Principles & UX Patterns for Agentic Systems](https://raw.githubusercontent.com/muriloscigliano/ai-playbook/refs/heads/main/AI_DESIGN_PRINCIPLES.md) | 17 原则 + 9 模式 + 自主性分类 | v1.1, 2026-04 |
| [Google PAIR: People + AI Guidebook](https://pair.withgoogle.com/guidebook/) | 权威设计指南 | 持续更新 |
| [Microsoft HAX Toolkit](https://www.microsoft.com/en-us/haxtoolkit/) | 18 条人机交互指南 | 持续更新 |
| [AG-UI Protocol](https://docs.ag-ui.com/introduction) | Agent 前端事件标准 | 2026 |
| [Claude Code: share session output as artifacts](https://code.claude.com/docs/en/artifacts) | 产物面板 | 2026 |
| [Cursor: Design Mode](https://cursor.com/blog/design-mode) | 视觉提示驱动 | 2026 |
| [assistant-ui](https://github.com/simonbengtsson/assistant-ui) | 开源聊天组件库 | 活跃 |
| [Nielsen Norman Group: Response Times](https://www.nngroup.com/articles/response-times-3-important-limits/) | 响应时间阈值 | 经典 |
| [NN/g: Progress Indicators](https://www.nngroup.com/articles/progress-indicators/) | 进度指示 | 经典 |
| [W3C WCAG 2.3.3 Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) | 动效无障碍 | WCAG 2.2 |

### 中文

| 资料 | 类型 |
| --- | --- |
| [Agentic UI 状态：如何展示 AI 思维、工具调用和进度](https://www.exodeui.com/zh-cn/learn/agentic-ui-states/) | 七状态设计（**最实用**） |
| [百万人都在用！深度拆解 Perplexity 的设计团队和产品体验](https://www.uisdc.com/perplexity-2) | 产品拆解 |
| [AI 智能体用户界面设计指南 T/ZSA 334—2026](https://www.ttbz.org.cn/standardDetail.html?id=radt2my6f54m7w4p0j57a91di48lkuz) | 团体标准 |
| [流式输出与交互体验：让"慢"变得可接受](https://bbs.huaweicloud.com/blogs/523901) | 流式体验 |
