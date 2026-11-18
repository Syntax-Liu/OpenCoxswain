# 与 DeepSeek Harness 源码的对照（2026-11-18）

> 对照对象：`deepseek-harness-master.zip`（57 MB）
> 本地解压位置：`/tmp/dsh-src/deepseek-harness-master`
>
> **这份文档只记事实与取舍，不记"谁更好"。**
> DSH 和我们是两种规模的项目，很多差异不是优劣，是体量决定的。

---

## 1. 体量对照

| 指标 | DSH | 我们 | 倍数 |
| --- | --- | --- | --- |
| CSS 文件 | **220** | 2（`styles.css` + `ui.css`） | 110× |
| CSS 行数 | **35,501** | ~7,000 | 5× |
| 客户端 TSX | **711** | ~60 | 12× |
| UI 相关包 | **60+**（`ui-chat` / `ui-settings` / `ui-theme` …） | 1（`apps/web`） | — |
| 设计令牌 | **450**（`--dsw-*`） | ~60 | 7.5× |
| 组件测试 | **92** 个文件 | 61（含非 UI） | — |
| 端到端快照场景 | **77** | 0 | — |

**结论**：DSH 是一个 60+ 包的 monorepo，界面按功能垂直切分；
我们是一个应用，界面平铺在 `components/`。

---

## 2. 我们做对了的（与 DSH 一致）

### 2.1 圆角令牌数值完全相同

| 令牌 | DSH | 我们 |
| --- | --- | --- |
| xs | 4px | 4px |
| sm | 8px | 8px |
| md | 12px | 12px |
| lg | 16px | 16px |
| xl | 20px | 20px |

这不是抄的——是两套体系各自收敛到同一个值。**说明这组数值是合理的。**

### 2.2 组件测试同样读 CSS 源码

DSH `button-styles.client.spec.ts`：

```ts
const css = readFileSync('../src/Button.module.css', 'utf8')
expect(declarations('md')).toContain('height: 36px;')
```

我们的 `buttonSystem.test.ts` 是同一思路。

**之前我以为"读源码做断言"是落后做法，这个判断是错的**——
DSH 也这么做，因为 CSS 没有运行时，静态断言是唯一的低成本手段。

### 2.3 都用连续曲率

两边都用了 `corner-shape`，都做了 `@supports` 降级。

---

## 3. 值得采纳的（DSH 做得更好）

### 3.1 ⭐ 连续曲率用 `superellipse(1.5)` 而不是 `squircle`

**这是本次对照最有价值的发现。**

```css
/* DSH */
@supports (corner-shape: superellipse(1.5)) {
  :root { --dsw-corner-shape: superellipse(1.5); }
  *, *::before, *::after { corner-shape: var(--dsw-corner-shape); }
}
```

实测确认：`superellipse(2)` **等于** `squircle`。

| 值 | 含义 |
| --- | --- |
| `round` | 圆弧（默认） |
| `superellipse(1.5)` | **DSH 用的**——介于圆弧与方角之间 |
| `superellipse(2)` = `squircle` | **我们用的**——更方 |

DSH 的注释解释了为什么选 1.5：

> between a circular arc (round = superellipse(1)) and a squircle
> (superellipse(2))

**影响**：我们用 `squircle` 会让 4px 的小圆角"更方"。在 22~26px 高的按钮上，
这可能就是"看起来硬"的原因之一。

**建议**：改成 `superellipse(1.5)`，或者做成令牌让人能调。

### 3.2 ⭐ 正圆和胶囊必须显式 opt out

DSH 的注释：

> Full-round shapes opt out where they are declared: a superellipse
> deforms a circle into a squircle and squares off capsule ends, so every
> effectively uncapped radius (50%, 100%, or a pill radius far above the
> box size) pairs `corner-shape: round` with its `border-radius`.

**这正是我们 `.jump-bottom` 变成方角的原因**——我们给几乎所有元素加了
`squircle`，却没有让正圆/胶囊退出。

DSH 还写了**样式表规范测试**强制这条配对（"The corner-shape stylesheet
spec enforces that pairing"）。

**建议**：
1. 给 `border-radius: 50%` 和胶囊（`calc(--h-* / 2)`）的元素加
   `corner-shape: round`
2. 加一条测试强制这条配对

### 3.3 用通用选择器一次覆盖，而非手写类名清单

```css
/* DSH */
*, *::before, *::after { corner-shape: var(--dsw-corner-shape); }

/* 我们 */
@supports (corner-shape: squircle) {
  .btn, .list-item, .md-body pre, .md-body code, ... { corner-shape: squircle; }
}
```

我们手写了 17 个类名，**漏掉的元素就没有连续曲率**，而且新增组件要记得加。

**建议**：改成通用选择器 + 上面 3.2 的 opt-out。

### 3.4 ⭐ UI 结构快照（77 个场景）

DSH `snapshots/web/` 下每个场景一个目录：

```
approval-composer/
  session.v2.jsonl      ← 会话数据
  snapshot.yml          ← 场景配置
  ui.expected.md        ← **期望的无障碍树**
  workspace.expected/   ← 期望的工作区文件
```

`ui.expected.md` 长这样：

```
- text: Waiting for approval
- group "Approval details": "Allow this operation..."
- button "Reject"
- button "Allow once"
```

**比截图好在哪**：比的是**语义结构**而不是像素——
改样式不会误报，改结构（少一个按钮、按钮改名）会准确报错。

**我们的现状**：用截图对比（`css-snapshot.mjs` 比计算样式），
能发现视觉变化，但发现不了"按钮不见了""aria-label 丢了"。

**建议**：这是最值得抄的一项。可以先做 5~10 个核心场景。

### 3.5 真实渲染测试（`@testing-library/react` + jsdom）

DSH 有 `.client.spec.tsx` 标准测试，用 `render()` / `fireEvent()` / `screen`。

**我们的现状**：`tsconfig.test.json` 排除了 `*.tsx`，**零渲染测试**。

我们之前在 `browser.mjs` 里记着"happy-dom + React 18 受控组件不可靠"，
并据此决定不做渲染测试。**DSH 用 jsdom 而非 happy-dom，这条路是通的。**

**建议**：先在 jsdom 下试 1~2 个组件；能跑通再逐步推。

### 3.6 界面按功能垂直切包

DSH 的 60+ 个 `ui-*` 包：`ui-chat` / `ui-settings` / `ui-sidebar` / `ui-approval`…

每个包自带 `src` / `tests` / `locale` / `README`。

我们的界面全在 `apps/web/src/components/` 下平铺。

**建议**：**不抄。** 我们的体量（60 个 TSX）还没到需要拆包的程度，
拆包会带来构建复杂度。等超过 200 个文件再考虑。

---

## 4. 不必采纳的

| DSH 的做法 | 为什么不抄 |
| --- | --- |
| 450 个令牌 | 体量决定的。60 个够用，多了反而难记 |
| 组件内写死字号（`font-size: 14px`） | 我们用 `--fs-sm` 令牌，支持字号缩放设置，更合适 |
| `md` 按钮 36px 高 | 我们 26px。DSH 的信息密度更低、留白更多，是不同定位 |
| 60+ 个独立 npm 包 | 见 3.6 |

---

## 5. 一条要纠正的旧结论

我之前在 `scripts/lib/browser.mjs` 和几份文档里写过：

> happy-dom + React 18 下受控组件不可靠，所以项目不做渲染测试。

**这个结论被 DSH 证伪了**——它用 jsdom 做渲染测试，规模比我们大得多。

准确的说法应该是：

> **happy-dom** 有这个问题，**jsdom** 没有。我们当初选错了库，
> 却把结论推广成了"渲染测试不可行"。

---

## 6. 建议的行动顺序

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| **1** | 连续曲率改成 `superellipse(1.5)` + 正圆/胶囊 opt-out | 改动小，直接影响观感 |
| **2** | 改成通用选择器覆盖 | 消除"新组件忘记加"的隐患 |
| **3** | 加一条测试强制 opt-out 配对 | 防回退 |
| 4 | 试 jsdom 渲染测试（先 1 个组件） | 验证后再推 |
| 5 | 做 5~10 个 UI 结构快照 | 投入较大，但收益最高 |

前三项是一轮能做完的。第四五项要单独排期。
