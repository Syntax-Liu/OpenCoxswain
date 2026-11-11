# @opencoxswain/web

工作台界面。布局对齐主流 Agent 软件（DeepSeek / TRAE）：**左侧导航 + 单页主区**。

## 运行

需要先启动运行时并开启 HTTP：

```bash
# 终端 1：运行时（默认监听 127.0.0.1:47900）
node apps/runtime/dist/cli.js --serve --static apps/web/dist

# 终端 2：界面开发服务器（热更新，/api 自动代理到运行时）
pnpm --filter @opencoxswain/web dev     # http://127.0.0.1:5180
```

也可以直接访问运行时的 `http://127.0.0.1:47900/`（它同时服务界面与 API，同源）。

## 版式

```
┌──────────────┬──────────────────────────────┐
│ ◎ 全局助理·B │                              │
│ ＋ 添加项目   │          主区                 │
│ ───────────  │   · 点文件夹 → 与 C 对话      │
│ 工作区        │   · 点对话   → D 的轨迹/续聊  │
│ ◇ opencoxswain│   · 点 B     → 跨项目路由     │
│   · 读任务1   │                              │
│   · 读任务2   │                              │
└──────────────┴──────────────────────────────┘
```

**核心映射**：

| 左侧元素 | 点开后是什么 |
| --- | --- |
| `◇ 项目文件夹` | **C（项目助理）**：项目的常驻会话 |
| `· 对话条目` | **D（执行者）**：完整执行轨迹，可继续追问 |
| `◎ 全局助理 · B` | 跨项目路由：判断该找哪个 C，转交原话 |

## 目录

```
src/
  main.tsx                  入口
  App.tsx                   导航状态与数据流
  api.ts                    REST 客户端 + SSE 订阅器（含退避重连）
  state.ts                  快照/增量合并（纯函数）
  test/
    state.test.ts           合并逻辑测试（11）
    render.test.ts          对话流过滤 + Markdown 解析测试（7）
  components/
    Sidebar.tsx             左侧导航：B + 工作区树（文件夹 = C，条目 = D）
    Conversation.tsx        与 C 的对话
    ExecutorChat.tsx        D 的轨迹视图 + 续聊输入框
    GlobalAssistant.tsx     B 的路由界面
    Markdown.tsx            轻量 Markdown 渲染
    OpenProjectDialog.tsx   打开项目
    SettingsDialog.tsx      模型密钥设置
  styles.css                深色主题
```

## 三条交互要点

| 界面行为 | 背后机制 |
| --- | --- |
| 发消息**立刻返回**，不等 C 回复 | `POST /say` 返回 202；C 的回复走 SSE |
| C 回复期间**输入框从不被禁用** | 「连发不打断」：消息进 Inbox 排队 |
| 点执行者 → 看完整轨迹并可追问 | `GET /executors/:id/messages` + `POST /executors/:id/say` |

## 两个必须守住的规则

### 1. 对话流只显示人和 C 说的话

`state.ts` 的过滤规则：

```ts
messages.filter(m => (m.role === 'user' || m.role === 'assistant') && !m.internal)
```

执行者的结算通知、工具调用、原始产出**都不进对话流**——它们在左侧各自
的对话里。早期版本把 `【执行者结算】` 整块渲染出来，那是明确的泄漏。

### 2. Markdown 必须渲染

C 的输出里有 `**粗体**`、`### 标题`、列表、表格、行内代码。
`Markdown.tsx` 是自实现的轻量解析器（不引依赖），支持：

- `**粗体**` / `*斜体*` / `` `行内代码` ``
- `#` / `##` / `###` 标题
- `-` / `1.` 列表（含缩进）
- ``` 代码块
- `| a | b |` 表格

## 状态管理

合并逻辑刻意做成**纯函数**并单独测试，因为这里是界面最容易出错的地方：

| 风险 | 处理 |
| --- | --- |
| 重连补发导致消息重复 | 按 `seq` 去重 |
| 增量丢失导致显示过期状态 | 收到 `gap` 事件时**重拉快照** |
| C 分段回复变成多条割裂消息 | 同一轮的多段 `assistant_text` 合并成一条 |

## 测试

```bash
pnpm --filter @opencoxswain/web test    # 18 条
pnpm --filter @opencoxswain/web build
```

## 尚未实现

| 项 | 说明 |
| --- | --- |
| 记忆文件可视化编辑 | TRAE 宝 的做法是「在编辑器里打开 md 文件」，可直接复用该思路 |
| 执行者筛选 / 搜索 | 项目多、对话多时需要 |
| 移动端适配 | 当前按桌面宽度设计 |
| 消息复制 / 重发 / 编辑 | 主流 Agent 软件都有 |

后续发展方向见 [`docs/roadmap.md`](../../docs/roadmap.md)。
