# DSH 设计令牌对照

> 记录于 2026-11-13（v0.72.0）
> DSH 是 MIT 开源，用户授权研究。

## 数据怎么来的

从**运行中的 DSH** 抓的：`--remote-debugging-port=9222` 连 Electron 主窗口，
遍历 `document.styleSheets` 提取全部自定义属性。

**543 个令牌。** headless Chrome 抓不到（需要认证），
打包产物里也没有（运行时注入）——只有连到真实窗口才行。

---

## 三层结构

```
--dsw-static-*    82 个   原始色板，只有色相和明度
--dsw-alias-*    114 个   语义别名，说"这块是什么用途"
--dsh-*          347 个   组件级，只服务一个组件
```

---

## 圆角：我们差 3~4 倍

| 档位 | DSH | 我们（改前） | 我们（改后） |
| --- | --- | --- | --- |
| xs | 4px | — | 3px |
| sm | 8px | 3px | 4px |
| md | 12px | 4px | 6px |
| lg | 16px | — | 10px |
| xl | 20px | — | 14px |
| panel | 28px | — | — |

**这是界面看着"生硬"的主要原因。** 所有东西都是方角感。

改后没有照抄 DSH 的数值——我们是暗色指挥台，比明亮界面更适合小一点的圆角。
取值原则是**每一档都能看出和相邻档的差别**。

---

## 动效时长：DSH 有令牌，我们是硬编码

DSH：

```
--ds-transition-duration-fast: .1s
--ds-transition-duration: .2s
--ds-transition-duration-slow: .3s
--ds-ease-in-out: cubic-bezier(.4, 0, .2, 1)
```

我们改前散着 6 处 `0.12s ease` / `0.1s ease`，没有统一节奏。

现在：

```
--dur-fast: 0.1s
--dur-base: 0.2s
--dur-slow: 0.3s
--ease: cubic-bezier(0.4, 0, 0.2, 1)
```

**测试会拦住新的硬编码时长。**

---

## 中性色阶：DSH 22 级，我们原来 7 级

DSH 的 `neutral-bluish` 从 `00`（白）到 `1000`（近黑），22 级，
且另有 `neutral`（纯灰）一套并行——**冷暖两套灰**。

暗色端尤其密：`750 / 800 / 850 / 875 / 900 / 950 / 1000`。

我们原来只有 `950 / 900 / 880 / 850 / 800 / 750 / 700`，7 级。
后果是"比面板深一点""比悬停浅一点"这类需求只能新造颜色。

改后补到 12 级（`1000 / 950 / 900 / 880 / 850 / 820 / 800 / 780 / 750 / 700 / 650`）。

---

## 字号：DSH 用一套增量变量

```
--dsh-content-font-size: 14px（可调）
--dsh-content-font-delta: calc(var(--dsh-content-font-size,14px) - 14px)
--dsh-content-font-size-secondary: min(calc(font - 1px), max(13px, calc(font - 2px)))
```

**核心思路**：只有一个"基准字号"用户可调，其它全部由它**算出来**。
调大基准，所有字号等比跟随。

我们的 `--font-scale` 是同一个思路，但 DSH 更细——它区分了
"正文基准"和"次要基准"两条派生链。

---

## 尺寸参考（DSH 实测值）

| 令牌 | 值 | 说明 |
| --- | --- | --- |
| `--dsh-sidebar-inline-padding` | 8px | 侧栏水平内边距 |
| `--dsh-sidebar-row-padding` | 12px | 侧栏行内边距 |
| `--dsh-sidebar-label-gap` | 6px | 侧栏图标与文字间距 |
| `--dsh-chat-content-width` | clamp(680, 64%, 920) | 聊天内容宽度 |
| `--dsh-chat-flow-gap` | 12px | 消息间距 |
| `--dsh-composer-text-max-height` | 336px | 输入框最大高度 |
| `--dsh-scrollbar-width` | 6px | 滚动条宽度（会话列表 5px） |
| `--dsh-windows-titlebar-height` | 40px | 标题栏高度 |
| `--dsh-trajectory-toolbar-height` | 32px | 轨迹页工具栏 |

---

## 还没跟进的

1. **组件级令牌（347 个）** — DSH 给每个组件都有专属变量，我们还没有。
   不需要全抄，但"组件自己的一组变量"这个做法值得用在复杂组件上
   （比如批次线、决策面板）。

2. **冷暖两套中性灰** — DSH 有 `neutral` 和 `neutral-bluish` 两套。
   我们只有冷的（冷蓝灰）。够用，但如果有"插入暖色块"的需求会缺一档。

3. **面板级大圆角（28px）** — DSH 用它做整块面板。
   我们没有对应的大容器，暂时不需要。

---

## 复核方式

想重新抓一遍：

```powershell
& "D:\Program Files\DeepSeekHarness\DeepSeek Harness.exe" --remote-debugging-port=9222
```

然后用 CDP 连 `http://127.0.0.1:9222/json/list`，找 `dsh-app://app/` 那个页面，
遍历 `document.styleSheets` 读所有 `--*` 属性。
