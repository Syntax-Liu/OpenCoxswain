# 文档索引

> **先看两份**：架构与能力边界 → [architecture.md](architecture.md)，
> 命名规则 → [glossary.md](glossary.md)。其余的按需要查。

---

## 一、项目本身

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 架构：四层结构、能力边界、模块划分 |
| [glossary.md](glossary.md) | **命名唯一权威**：代码、文档、界面、提交信息一律以此为准 |
| [research.md](research.md) | 能力面与交互设计的调研结论 |

---

## 二、功能说明（每个都有边界声明）

| 文档 | 内容 | 边界 |
| --- | --- | --- |
| [sandbox.md](sandbox.md) | 命令沙箱 | 静态检查，**非进程隔离** |
| [code-navigation.md](code-navigation.md) | 代码导航 | 词法级，**非真 LSP** |
| [attachments.md](attachments.md) | 附件（拖入/粘贴/选择） | 只做图片和文本文件 |
| [undo.md](undo.md) | 撤销 | **只做文件写入** |
| [skills.md](skills.md) | 技能（SKILL.md） | 按需加载 |
| [mcp.md](mcp.md) | MCP 接入 | 只做 stdio 传输 |
| [extensions.md](extensions.md) | 扩展口 | 不是插件系统 |

---

## 三、界面

| 文档 | 内容 |
| --- | --- |
| [ui-dev-guide.md](ui-dev-guide.md) | **界面开发手册**：现状地图、令牌全表、打磨清单、改造流程、验收命令、常见坑 |
| [control-spec.md](control-spec.md) | **控件唯一真相**：`src/ui/` 的组件清单、尺度表、"三件不许做" |
| [shortcuts.md](shortcuts.md) | 键盘快捷键 |
| [usability-plan.md](usability-plan.md) | 易用性改造记录 |

---

## 四、工程

| 文档 | 内容 |
| --- | --- |
| [release.md](release.md) | 发布与自动更新（签名、NSIS、latest.json） |

---

## 写文档的约定

1. **每个功能文档必须写清边界**——"做不到什么"比"能做什么"更重要
2. **不新增文档**，先问能不能并进现有的
3. **过时就删**，不要留在主目录里误导人
4. 文档里的数字（测试数、版本号）**改了代码要同步**
