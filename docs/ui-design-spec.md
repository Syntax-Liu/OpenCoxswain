# OpenCoxswain 界面设计规范

> 版本：2026-11-14 ｜ 适用：`apps/web`
> **这不是"愿景文档"，是施工规范。** 文中每个数值、令牌名、组件约束都能在代码里找到出处，并标注了对应文件与被测试锁死的位置。
> 开发者改界面前必须读完第 0 节与第 9 节。

---

## 0. 先读这一节：三条不可违反的原则

违反这三条中的任何一条，界面在评审时都会被退回。

### 原则一：这是桌面软件，不是手机 App

**出处**：`apps/web/src/styles.css` 文件头注释。

- 小圆角 + 细边框分层，不靠大色块堆叠；
- 高信息密度，桌面用户一次要看更多东西；
- 不为移动端做妥协式布局。窗口窄于 1180px 时收右栏，**但不改变组件形态**。

### 原则二：琥珀色只表示"需要你操作"

**出处**：`apps/web/src/components/semanticColor.ts`。

> **琥珀不能用于装饰。** 图标、分隔线、容器背景都不许用。

理由是踩过的坑：曾经"待决定圆点、结论链接、任务状态点、压缩警告、闪电图标"**五种含义共用一个琥珀色**，结果真要表达"这里需要你注意"时已经没有更强的颜色可用。

映射表是**唯一权威**，新增状态先查表，不许自己挑颜色：

| 语义 | 令牌 | 只用于 |
| --- | --- | --- |
| `action` | `--accent` | 需要用户操作（待决策、可点击的链接） |
| `info` | `--info` | 中性信息、排队中 |
| `success` | `--ok` | 成功完成 |
| `danger` | `--danger` | 失败、危险动作 |
| `muted` | `--text-dim` | 未开始、已取消、辅助信息 |
| `neutral` | `--text` | 普通正文 |

状态 → 语义的映射由 `toneForStatus()` 提供，**不许在组件里另写 switch**。

### 原则三：只有原始色板允许写十六进制颜色

**出处**：`apps/web/src/test/tokens.test.ts`（**已被测试锁死**）。

```css
--c-neutral-950: #0a0c0f;                          /* ✅ 原始层：写色值 */
--color-surface-canvas: var(--c-neutral-950);      /* ✅ 语义层：只引用原始层 */
--bg: var(--color-surface-canvas);                 /* ✅ 旧名别名：指向语义层 */

--color-surface-canvas: #0a0c0f;                   /* ❌ 语义层写死色值，测试会红 */
```

测试会扫描整个 `styles.css`，一旦 `--color-*` 里出现字面色值就失败。**这是硬约束，不是建议。**

---

## 1. 整体布局

### 1.1 三栏骨架

```
┌──────────────────────────────────────────────────────────────────┐
│ TitleBar  面包屑：项目 › 会话                          [窗口控制] │
├────────────┬───────────────────────────────┬─────────────────────┤
│            │                               │                     │
│  Sidebar   │           Main                │      RightRail      │
│  244px     │      （宽度 = 剩余全部）       │      待决策/文件     │
│  可拖拽    │                               │      可折叠          │
│  可折叠    │  消息区 max-width: 760px      │                     │
│            │  输入框 max-width: 820px      │                     │
│            │                               │                     │
└────────────┴───────────────────────────────┴─────────────────────┘
```

**实现位置**：`App.tsx` 的 `.app-shell` 使用 CSS Grid，三列宽度由**内联 style** 控制：

```tsx
gridTemplateColumns: [
  sidebarCollapsed ? '0' : `${sidebarWidth}px`,
  'minmax(0, 1fr)',
  railCollapsed ? '0' : `${railWidth}px`,
].join(' ')
```

> ⚠️ **踩过的坑**：曾把列宽写死在 CSS 里（244px），侧栏内部改 `width` 时网格列不跟随，用户拖动"毫无反应"。**列宽必须由 JS 控制，CSS 里写 `auto`。**

### 1.2 折叠行为

- **折叠 = 整块隐藏（`display: none`），不是收窄**。收窄到几十像素比隐藏更难看。
- 包裹层（`.sidebar-slot`）必须撑满高度，否则"已连接/设置"贴不到底部。
- 折叠状态是纯界面状态，**不持久化**（项目折叠状态同理）。

### 1.3 断点

| 宽度 | 行为 |
| --- | --- |
| ≥ 1180px | 三栏全开（默认） |
| < 1180px | **右栏默认收起**（可由用户手动展开） |
| < 820px | 主区内容按 `minmax(0,1fr)` 收缩，不做移动端重排 |

---

## 2. 设计令牌（三层结构）

**出处**：`styles.css` 的 `:root`，结构照 DSH。

```
--c-*        原始层   色板。只有这里允许十六进制
--color-*    语义层   含义 → 色板。只允许 var(--c-*)
--accent 等  旧名别名  指向语义层（历史遗留 445 处引用，新代码不要用）
```

### 2.1 原始色板

**中性（冷蓝灰）**——暗色端 12 级，只变明度不偏色：

| 令牌 | 色值 | 用途 |
| --- | --- | --- |
| `--c-neutral-1000` | `#07080a` | 遮罩底 |
| `--c-neutral-950` | `#0a0c0f` | 画布 |
| `--c-neutral-900` | `#0d1013` | 侧栏 |
| `--c-neutral-880` | `#0e1216` | 输入框（凹陷） |
| `--c-neutral-850` | `#11151a` | 面板 |
| `--c-neutral-800` | `#171c23` | 抬起的元素 |
| `--c-neutral-750` | `#1a2028` | 悬停 |
| `--c-neutral-700` | `#1f262f` | 选中 |
| `--c-neutral-600` | `#545c65` | 元信息 |
| `--c-neutral-500` | `#7a828b` | 次要文字 |
| `--c-neutral-300` | `#c4cbd3` | 正文 |
| `--c-neutral-100` | `#e8eaed` | 标题、关键值 |

**琥珀**（唯一的高亮色相）：`600 #6b4f22` / `500 #c98b4b` / `400 #e0a04a` / `300 #eab366`

**功能色**（低饱和，不与琥珀抢注意力）：`green-500 #5a8f7b` / `red-500 #b85450` / `blue-500 #5a7d99`

**边框**（白色低透明度，靠背景透出来）：`overlay-06` / `overlay-11` / `overlay-20`（结构分隔线专用）

> 这些色值全部被 `tokens.test.ts` 的「改造前后颜色一致」用例逐一锁死。**改色会被测试拦下**——改色是设计决策，必须先改测试并说明理由。

### 2.2 表面层次

数字越大，离用户越近（越浅）：

```
canvas → sidebar → sunken(输入框) → panel → raised → hover → selected
```

**只变明度，不加色相。** 这是"夜幕指挥台"的气质来源。

### 2.3 字号

```css
--fs-xs: calc(12px * var(--font-scale));   /* 标签、行内代码、小徽章 */
--fs-sm: calc(13px * var(--font-scale));   /* 按钮、输入框、tab */
--fs-md: calc(15px * var(--font-scale));   /* 主操作按钮、正文 */
--fs-lg: calc(17px * var(--font-scale));   /* 标题 */
```

**字号必须乘 `--font-scale`**，否则字号缩放功能会漏掉这块。

字号缩放档位（`fontScale.ts`）：

| 档位 | 系数 |
| --- | --- |
| 小 | 0.94 |
| 标准 | 1.00 |
| 大 | **1.08（默认）** |
| 更大 | 1.16 |

> 默认不是"标准"，因为实测标准档在 2K 屏上偏小。

### 2.4 圆角

```
--r-xs: 4px   标签、小徽章
--r-sm: 8px   按钮、输入框、下拉
--r-md: 12px  面板、卡片、气泡
--r-lg: 16px  浮层、模态、输入框容器
--r-xl: 20px  大面板、空态插画容器、panel 28px
```

档位必须**严格递增**（测试锁死）。历史教训：曾只有 3px/4px 两档，比 DSH 小 3~4 倍，**这是界面看起来"生硬"的主要原因**。

### 2.5 间距

```
--g-05: 2px   紧贴：图标与文字
--g-1:  4px
--g-15: 6px   紧凑：芯片内边距
--g-2:  8px
--g-25: 10px  行内边距、按钮水平内边距
--g-3:  12px
--g-4:  16px  消息之间、消息区四周
--g-5:  24px
--g-6:  32px
```

**禁止裸写 px 做间距。** 历史账：CSS 里曾有 86 处裸 px（2/4/6/7/8/10/12px），其中 7px 是拼错的。

### 2.6 动效

```
--dur-fast: 0.1s   悬停、按钮
--dur-base: 0.2s   展开、淡入
--dur-slow: 0.3s   面板滑入
--ease: cubic-bezier(0.4, 0, 0.2, 1)   先快后慢
```

**禁止硬编码 `transition` 时长**（测试会扫 `0.12s` 这类值并失败）。

### 2.7 组件级令牌

| 令牌 | 值 | 说明 |
| --- | --- | --- |
| `--sidebar-width` | `244px` | 侧栏总宽 |
| `--content-read` | `760px` | 阅读优先（消息、文档） |
| `--content-wide` | `820px` | 宽版（输入框、状态栏） |
| `--composer-min-height` | `52px` | textarea 起始高度 |
| `--composer-max-height` | `180px` | 长到这个高度就不再长 |
| `--dot-size` | `5px` | 状态点 |
| `--dot-size-lg` | — | 状态点大档 |
| `--scrollbar-width` / `--scrollbar-width-thin` | — | 滚动条两档 |

> ⚠️ **令牌不能引用自己**。曾踩过批量替换把 `--composer-max-height: 180px` 改成 `var(--composer-max-height)`，**循环引用不报错、只是静默失效**，输入框高度直接没了。测试里有专门用例。

---

## 3. 信息架构

### 3.1 左侧导航（`Sidebar.tsx`）

布局照 DeepSeek Harness，视觉照 VS Code：

```
[◎ 新会话]                    ← 顶部大按钮
  ⌘ Supervisor                  ← nav-item
──────────────────────────
工作区              ⌕ ⇅ ＋      ← 标题行带小图标
 ▾ 项目名                      ← 点击 = 进该项目的 C（Assistant）
     对话标题        已完成      ← 点击 = 看某个 D（Agent）；右对齐状态
```

**三种视图**：

| 视图 | `view.kind` | 含义 |
| --- | --- | --- |
| 新会话 | `'new'` | 还没选项目，两个导航项都**不算**当前项目 |
| Supervisor | `'global'` | B 层：跨项目路由 |
| 项目 | 项目 id | C 层：该项目常驻会话 |

**行高（对齐 DSH，测试锁死）**：

| 元素 | 高度 | 说明 |
| --- | --- | --- |
| `.nav-item` | `30px` | DSH 是 22px，但那是 14px 字号；我们字号大一号，行高要相应加大 |
| `.project-folder` | **`34px`** | 文字只有 20px，剩下 14px 是**留白** |
| `.thread-item` | **`32px`** | 同理，12px 是留白 |

> **关键认知**：DSH 的行容器比文字高 12–14px，那点多余高度就是"宽松感"。我们之前行高 = 文字高度，所以显得密。**行高比文字高，是故意的。**

### 3.2 主区（`Main`）

- `UpdateBanner`（有更新才出现）
- `ApprovalPanel`（有审批请求才出现；多个 Agent 同时请求时**必须标明是谁要干**）
- `Conversation`（对 Assistant 说话）或 `ExecutorChat`（对 D 说话）或 `GlobalAssistant`（对 B 说话）
- 新会话空态：`NewSession`

### 3.3 右侧栏（`RightRail.tsx`）

三个可折叠 Section：

| Section | 默认 | 内容 |
| --- | --- | --- |
| 待决策 | **展开** | 带数量 badge |
| 工作区文件 | 收起 | 文件列表 |
| 快捷操作 | 展开 | 常用动作 |

> 待决策面板从主区挪到右栏的原因：主区要留给对话，决策项是"顺手看一眼"而不是"必须挡路"。

---

## 4. 核心组件规范

### 4.1 消息区（`.messages`）

```
gap:    var(--g-4)      /* 16px */
padding: var(--g-4)     /* 四周 16px */
max-width: var(--content-read)  /* 760px，阅读优先 */
```

### 4.2 气泡（`.bubble`）

```
padding: var(--g-25) var(--g-3)   /* 10px 12px */
```

### 4.3 输入框（Composer）

- 起始高度 `--composer-min-height`（52px）；
- 长到 `--composer-max-height`（180px）后**内部滚动，不再变高**；
- 容器圆角用 `--r-lg`；
- `Enter` 发送，`Shift+Enter` 换行；
- 发送后**立即清空并给出反馈**，不阻塞。

### 4.4 状态点

用 `--dot-size`（5px），颜色**必须**来自 `toneForStatus(status)`。

| 状态 | 语义色 |
| --- | --- |
| `running` / `starting` | `action`（琥珀） |
| `queued` | `info` |
| `done` | `success` |
| `failed` | `danger` |
| `cancelled` / 其他 | `muted` |

### 4.5 命令面板（`CommandPalette.tsx`）

`Ctrl+K` 唤起。列项目 / 会话 / 动作三类。

### 4.6 设置弹窗（`SettingsDialog.tsx`）

分页：模型、权限、主题、字号、IM、关闭行为、更新。

---

## 5. 交互规范

### 5.1 键盘快捷键（`shortcuts.ts`）

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+K` | 命令面板 |
| `Ctrl+N` | 新对话 |
| `Ctrl+,` | 打开设置 |
| `Ctrl+B` | 折叠/展开侧栏 |
| `Ctrl+1..9` | 切到第 N 个项目 |
| `Esc` | 关闭弹层 / 取消当前操作 |
| `Enter` / `Shift+Enter` | 发送 / 换行 |

**三条设计原则**：

1. **不和输入框抢键**。在 `textarea`/`input` 里打字时只响应带修饰键的组合（`Ctrl+K` 可以，单独的 `/` 不行）。
2. **不和浏览器抢键**。只用 `Ctrl/Cmd` 组合，不占 `F5`、`Ctrl+W` 这类用户预期由浏览器处理的键。
3. **`Esc` 例外**：在任何地方都要能关闭当前弹层，**包括输入框里**。用户按 Esc 想关的是弹层，不是取消输入。

### 5.2 加载与反馈

- 所有异步动作必须有**进行中**状态；
- **失败必须给可读原因**，不许只显示"出错了"（见 `errorDisplay.ts`）；
- 错误文案要**告诉用户下一步做什么**，而不只是描述症状。

### 5.3 空态

- 无项目：引导接入项目；
- 无对话：`NewSession` + `Onboarding`；
- 无待决策：不显示空的 panel，直接隐藏。

---

## 6. 主题与字号

### 6.1 主题切换

**只覆盖原始色板**：

```css
<html data-theme="light"> → 重新定义 --c-* → 语义层与所有组件自动跟随
```

> 这和字号缩放的思路一样：**改一个源头，全站生效**。直接改组件里的颜色会漏、会不一致。

- 默认 **dark**（产品定位是"夜幕指挥台"，暗色是它的本色）；
- 用 `data-theme` 属性而非 class，语义更贴近、不易与布局类名冲突；
- 存储键 `opencoxswain:theme`，非法值退回默认。

### 6.2 字号缩放

改 `--font-scale` 一个变量，所有 `--fs-*` 自动跟随。**新增字号必须写成 `calc(Npx * var(--font-scale))`。**

---

## 7. 组件目录与职责

新增组件前先看有没有可复用的：

| 文件 | 职责 |
| --- | --- |
| `Conversation.tsx` | 与 Assistant 的对话 |
| `ExecutorChat.tsx` | 与 Agent 的对话（含轨迹） |
| `GlobalAssistant.tsx` | 与 Supervisor 的对话 |
| `TraceView.tsx` | Agent 的执行轨迹查看 |
| `ApprovalPanel.tsx` | 危险动作审批 |
| `DecisionPanel.tsx` | 待决策项 |
| `Markdown.tsx` | Markdown 渲染 |
| `MentionPicker.tsx` | `@` 提及项目/会话 |
| `Select.tsx` / `TemplatePicker.tsx` / `ProjectPicker.tsx` | 选择器族 |
| `icons.tsx` | 图标集（内联 SVG，不引图标库） |
| `MessageActions.tsx` | 单条消息的操作（复制/重试/追问） |
| `AttachmentStrip.tsx` | 附件条 |

**样式一律写在 `styles.css`，不写 CSS-in-JS、不引 UI 库。** 现状就是纯手写 CSS + 设计令牌，保持这个一致性。

---

## 8. 无障碍与可读性

- 所有图标按钮必须有 `title` 或 `aria-label`（例：`aria-label="侧边栏"`）；
- 弹层用 `role` 与焦点陷阱；
- 可交互元素保留可见焦点环，颜色用 `--color-border-focus`（琥珀）；
- **不能只靠颜色传达状态**——状态点旁边要有文字或 `title`。

---

## 9. 改界面前的检查清单

提交前逐条确认，**任何一条不通过都会被退回**：

```
[ ] 没有在 --color-* 里写十六进制颜色
[ ] 没有裸写间距 px（用 --g-*）
[ ] 没有硬编码 transition 时长（用 --dur-*）
[ ] 字号写成 calc(Npx * var(--font-scale))
[ ] 琥珀色只用在"需要用户操作"的元素上
[ ] 状态颜色来自 toneForStatus()，没有自写 switch
[ ] 行高比文字高度大（留出 12–14px 留白）
[ ] 新增令牌没有引用自己
[ ] 折叠是 display:none，不是收窄
[ ] 网格列宽由 JS 控制，CSS 里是 auto
[ ] 图标按钮有 title / aria-label
[ ] 失败路径给了可读原因
```

对应自动化测试（**必须全绿**）：

```bash
pnpm --filter @opencoxswain/web test
```

覆盖的测试文件：`tokens.test.ts`（令牌三层结构）、`spacing.test.ts`（行高与间距）、`theme.test.ts`（主题）、`fontScale.test.ts`（字号）、`semanticColor.test.ts`（颜色语义）、`navVisual.test.ts`（导航视觉）。

---

## 10. 常见错误（都是真踩过的）

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| 把列宽写死在 CSS | 拖拽侧栏"毫无反应" | 列宽由 JS 内联 style 控制 |
| 令牌引用自己 | **不报错**，静默失效（输入框高度没了） | 定义时不要写成 `var(自己)` |
| `font-size: var(--fs-md) var(--fs-sm)` | 整条规则失效 | 一个属性只写一个值，只有 `padding`/`margin` 可用两值 |
| 折叠时只改 width | 窄条比隐藏更难看 | `display: none` |
| 一个颜色承担多种含义 | 真要提示时没有更强的颜色可用 | 查 `semanticColor.ts` 的表 |
| 圆角只用 3–4px | 界面"生硬" | 用 5 档 `--r-*` |
| 行高 = 文字高度 | 界面"挤" | 行容器比文字高 12–14px |
| 事件监听挂 `window` | 鼠标快速移出窗口丢事件 | 挂 `document` |

---

## 11. 扩展指引：要加新东西时怎么办

### 加一个"状态"
1. 先在 `semanticColor.ts` 的 `toneForStatus()` 里加映射；
2. 不要自己挑颜色；
3. 更新 `semanticColor.test.ts`。

### 加一个尺寸档
1. 判断是否真的需要新档（优先复用现有 9 档间距 / 5 档圆角）；
2. 加进 `:root` 并保持**严格递增**；
3. 更新 `tokens.test.ts`。

### 加一个页面
1. 先判断是"新视图"还是"新 Section"——**优先做成主区的一个 view**，不要轻易加第四栏；
2. 在 `App.tsx` 的视图分支里接入；
3. 空态、加载、失败三态都要有。

### 加一个图标
1. 加到 `icons.tsx`，内联 SVG，保持 `currentColor`；
2. 不引入图标库（体积与一致性考虑）。

---

## 12. 一句话总结

> **这是桌面软件：小圆角、细边框、高密度。**
> **琥珀只表示"需要你操作"，其余一概不用。**
> **色值只写在原始层，间距/圆角/动效只用令牌，字号必须乘缩放系数。**
>
> 拿不准时：先看 `tokens.test.ts` 和 `spacing.test.ts` 里写了什么，那就是规范。
