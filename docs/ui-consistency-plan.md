# 控件样式统一改造方案

> 日期：2026-11-14 ｜ 对象：`apps/web`
> 问题：**界面 bug 较多，控件样式不统一**——同一种按钮存在多种变体。
> 本文基于对 `styles.css`（5788 行）的**逐条实测**，不是设计愿景。
>
> **状态：已实施（第 1、2、3 批 + 输入框未完成）。实测结果见文末 §10。**

---

## 0. 调研说明与一节必要的坦白

用户要求调研 DSH、TRAE、WorkBuddy、智谱等同类产品的界面设计。

**这一轮我没能拿到竞品的一手视觉资料**：外部抓取连续失败（GitHub raw、cdn.jsdelivr 均 fetch failed），搜索引擎只返回二手摘要。所以下面**不写"竞品是这么做的"这种没有证据支撑的话**。

替代做法是两条都有据可依的路径：

1. **本地技能规范**：`interface-design` 技能给出的控件体系原则（native → primitive → hand-roll 的优先级、变体收敛、状态完备）。
2. **本仓库代码实测**：所有数字都是从 `styles.css` 里数出来的，可复核。

> 补充一句行业普遍共识（作为参照，非实证）：主流产品的按钮体系普遍收敛为 **2–3 种变体 × 2–3 种尺寸**（primary / secondary / ghost × sm / md / lg），而不是每种用途各写一个类。这既是可维护性问题，也是视觉一致性问题。

---

## 1. 实测诊断：问题到底有多大

以下全部是 `styles.css` 里的真实计数。

### 1.1 按钮：69 个独立选择器，没有变体体系

```
按钮/控件类选择器总数：69
```

其中**同尺寸按钮的视觉属性各自实现**：

| 选择器 | 高度 | 内边距 | 圆角 | 字号 |
| --- | --- | --- | --- | --- |
| `.icon-btn` | `--h-sm` (22) | `0` | `--r-md` | `--fs-sm` |
| `.composer-chip` | `--h-sm` | `0 var(--g-2)` | `--r-sm` | `--fs-sm` |
| `.theme-btn` | `--h-sm` | `0 var(--g-3)` | `--r-sm` | `--fs-sm` |
| `.font-scale-btn` | `--h-sm` | `0 var(--g-3)` | `--r-sm` | `--fs-sm` |
| `.project-picker-btn` | `--h-sm` | `0 var(--g-2)` | `--r-sm` | `--fs-sm` |
| `.ui-select-btn` | **`32px` 硬编码** | `0 var(--g-2)` | `--r-sm` | `--fs-sm` |
| `.msg-action-btn` | **`26px` 硬编码** | `0` | `--r-sm` | — |
| `.view-tab` | `--h-md` (26) | `0 var(--g-3)` | **`--r-md`** | **`--fs-md`** |
| `.chip` | **无高度** | **`5px 8px` 裸值** | `--r-md` | `--fs-sm` |
| `.trace-filter-btn` | **无高度** | **`3px 9px` 裸值** | `--r-sm` | `--fs-xs` |
| `.attach-btn` | `--h-sm` | `0 var(--g-2)` | **无** | **`--fs-lg`** |
| `.back-btn` | **无高度** | **`3px 8px` 裸值** | `var(--radius-sm)` | `--fs-sm` |

**这就是用户说的"某一种按钮有好几种变体"。** 同样是 22px 高的小按钮，圆角有的 `--r-md` 有的 `--r-sm`；同样是"胶囊"，有的没高度靠 padding 撑。

### 1.2 悬停态：同一个动作三种写法

| 选择器 | hover 背景 |
| --- | --- |
| `.icon-btn:hover` | **`rgba(255, 255, 255, 0.06)`** ← 裸值，亮色主题下变成灰斑 |
| `.composer-chip:hover` | `var(--bg-hover)` |
| `.project-picker-btn:hover` | `var(--color-surface-hover)` |
| `.theme-btn:hover` | **只有文字色，没有背景** |
| `.font-scale-btn:hover` | **只有边框色，没有背景** |

四种不同的"悬停反馈"，其中一个是破坏主题的裸值。**这是最容易被用户感知为"样式不统一"的地方。**

### 1.3 令牌体系自相矛盾：两套命名并存

| 套系 | 定义 | 使用 |
| --- | --- | --- |
| 新：`--r-xs…--r-xl` | ✅ 5 档 | 主用 |
| 旧：`--radius` / `--radius-sm` / `--radius-lg` | 存在，但只是**转发**到新令牌 | 少量残留 |

```css
--radius-sm: var(--r-sm);   /* 旧名转发 */
--radius-lg: var(--r-md);   /* ⚠️ 名字说 lg，实际给的是 md！ */
```

`--radius-lg` 指向 `--r-md`（12px），名字与实际不符——**这是语义陷阱**，`0.x` 版本最容易带病扩散。

同理 `--h-sm/md/lg`（22/26/32）与 `--r-*`、`--g-*` 并存，造成"这个按钮该多高"没有唯一答案。

### 1.4 输入框：15 处焦点态各写各的

`.field input`、`.approval-actions input`、`.sidebar-filter input`、`.composer textarea`、`.template-form textarea`、`.workspace-search`……**每个容器都重新定义一遍输入框与焦点环**。

后果：改一次焦点环样式要改 10+ 处，漏一处就不一致。

### 1.5 裸值规模

| 类别 | 数量 |
| --- | --- |
| `padding` 裸 px | 97 处 |
| `margin` 裸 px | 41 处 |
| `gap` 裸 px | 18 处 |
| `height` 裸 px | 35 处 |
| `width` 裸 px | 37 处 |
| `max-width` 裸 px | 14 处 |
| 原始层之外的十六进制颜色 | **64 处** |

其中已确认的 bug 级问题：

```css
button.primary:hover:not(:disabled) { background: #5f9aff; }
```

**`#5f9aff` 是亮蓝色**，直接违反"琥珀是唯一高亮色相"的既定规则，且绕过原始层色板。这类"手滑写错色值"是 `--color-*` 体系本该拦住、但因存在裸写而漏网的典型。

---

## 2. 根因

不是"某几处写错了"，是**缺少组件层**：

```
现状：  CSS 直接写元素样式 ── 69 个类各自实现 ── 无公共契约
应有：  设计令牌 → 组件变体（有限的组合）── 页面只用变体
```

`button {}` 基础规则**存在**（有 font/cursor/radius/border/height/transition），说明作者已经想到了统一。但它只覆盖"默认长什么样"，**没覆盖 hover / active / disabled / variants**，于是每个使用处各自补，越补越散。

---

## 3. 目标体系：3 变体 × 3 尺寸

### 3.1 变体（按"重要性"分，不按用途分）

| 变体 | 用途 | 视觉 |
| --- | --- | --- |
| `primary` | 页面唯一的主要动作 | 琥珀底 + 深色文字 |
| `secondary` | 常规动作 | 透明底 + 边框 + 正文色 |
| `ghost` | 低干扰动作（图标、行内） | 无边框，hover 才出底 |
| `danger` | 危险动作 | 红字，仅 hover 出红底 |

**只允许这 4 个变体。** 新增"今天这个场景特殊"的念头出现时，先问：它能不能用现有变体 + 不同尺寸表达？

### 3.2 尺寸

| 尺寸 | 高度 | 水平内边距 | 圆角 | 字号 |
| --- | --- | --- | --- | --- |
| `sm` | 22px | 8px | `--r-sm` | `--fs-sm` |
| `md` | 26px | 12px | `--r-sm` | `--fs-md` |
| `lg` | 32px | 16px | `--r-sm` | `--fs-md` |

> **关键决策：圆角统一用 `--r-sm`（8px），不再中大小混用 `--r-md`。**
> 原来 `.icon-btn` 和 `.view-tab` 用 `--r-md` 是历史遗留，同一行按钮圆角不同正是"不协调"的观感来源。
> 只有"胶囊"形态（`.send-btn` 之类）保留 `50%`，且必须显式使用 `.btn--pill`。

### 3.3 状态：每个变体必须完整

`default / hover / active / focus-visible / disabled` 五态齐全。

**统一从语义令牌取色**，禁止裸值：

```css
/* hover 一律用同一组令牌，不再各写各的 */
background: var(--color-surface-hover);
```

**`focus-visible` 统一为**：

```css
outline: 2px solid var(--color-border-focus);
outline-offset: 2px;
```

不用 `border-color` 改边框（会撑动布局），用 `outline`（不占位）。

---

## 4. 分步实施

### 第 1 步：清理令牌矛盾（影响最大、风险最低）

1. 删除 `--radius` / `--radius-sm` / `--radius-lg` 三个转发令牌，**全部改用 `--r-*`**；
2. 修正 `--radius-lg` 的语义错误（它指向 `--r-md`）；
3. 补齐 `--h-*` 与尺寸表的对应关系，`.ui-select-btn` / `.msg-action-btn` 的硬编码高度改用令牌。

**验证**：`grep` 确认 `--radius` 零命中；`pnpm --filter @opencoxswain/web test` 全绿。

### 第 2 步：建立 `.btn` 组件契约

在 `styles.css` 中新增一段（放在 `button {}` 之后）：

```css
/* ============================================================
   按钮组件契约
   ------------------------------------------------------------
   变体：primary / secondary / ghost / danger
   尺寸：sm / md / lg
   状态：hover / active / focus-visible / disabled
   规则：页面里只用 .btn.btn--<variant>.btn--<size>，不再写独立按钮类
   ============================================================ */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--g-1);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}

/* ---- 尺寸 ---- */
.btn--sm { height: var(--h-sm); padding: 0 var(--g-2);  font-size: var(--fs-sm); }
.btn--md { height: var(--h-md); padding: 0 var(--g-3);  font-size: var(--fs-md); }
.btn--lg { height: var(--h-lg); padding: 0 var(--g-4);  font-size: var(--fs-md); }

/* ---- 变体 ---- */
.btn--primary {
  background: var(--color-action);
  color: var(--c-neutral-1000);
}
.btn--primary:hover:not(:disabled) { background: var(--color-action-hover); }

.btn--secondary {
  background: transparent;
  border-color: var(--color-border-strong);
  color: var(--color-label-primary);
}
.btn--secondary:hover:not(:disabled) { background: var(--color-surface-hover); }

.btn--ghost {
  background: transparent;
  color: var(--color-label-secondary);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--color-surface-hover);
  color: var(--color-label-primary);
}

.btn--danger {
  background: transparent;
  color: var(--color-danger);
}
.btn--danger:hover:not(:disabled) { background: var(--color-surface-hover); }

/* ---- 统一状态 ---- */
.btn:active:not(:disabled) { transform: scale(0.97); }
.btn:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 胶囊形态显式声明，不靠意外继承 */
.btn--pill { border-radius: 50%; }
```

**要点**：
- `transform: scale(0.97)` 给按压反馈，但**不改变布局**；
- 用 `:not(:disabled)` 而非 `:not([disabled])`，覆盖更全；
- 所有颜色走语义令牌，**零裸值**。

### 第 3 步：逐个迁移（按风险从低到高）

**迁移顺序很重要**——先迁低风险、再迁高频，避免一次性大爆。

| 批次 | 选择器 | 映射到 | 风险 |
| --- | --- | --- | --- |
| 1 | `.icon-btn` | `.btn.btn--ghost.btn--sm` | 低（纯图标） |
| 1 | `.theme-btn` / `.font-scale-btn` | `.btn.btn--secondary.btn--sm` | 低（设置页） |
| 1 | `.msg-action-btn` | `.btn.btn--ghost.btn--sm` | 低 |
| 2 | `.composer-chip` / `.chip` | `.btn.btn--secondary.btn--sm` / `--pill` | 中 |
| 2 | `.trace-filter-btn` | `.btn.btn--ghost.btn--sm` | 中 |
| 2 | `.project-picker-btn` / `.perm-picker-btn` | `.btn.btn--secondary.btn--sm` | 中 |
| 3 | `.view-tab` | `.btn.btn--ghost.btn--md` + `.is-active` | **高（有选中态）** |
| 3 | `.send-btn` | `.btn.btn--primary.btn--md.btn--pill` | **高（主操作）** |
| 3 | `.ui-select-btn` | `.btn.btn--secondary.btn--md` | **高（有下拉）** |

**每迁一批就提交一次**，跑测试，看界面。不要一次迁完再验。

### 第 4 步：输入框契约（与按钮同构）

```css
.input {
  height: var(--h-lg);
  padding: 0 var(--g-2);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--r-sm);
  color: var(--color-label-primary);
  font-family: inherit;
  font-size: var(--fs-sm);
}
.input:hover  { border-color: var(--color-border-strong); }
.input:focus,
.input:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: -1px;
  border-color: transparent;
}
.input:disabled { opacity: 0.45; cursor: not-allowed; }
```

然后把 `.field input`、`.approval-actions input`、`.sidebar-filter input`、`.template-form textarea` 等**全部改为复用 `.input`**，只保留真正特殊的宽度/高度覆写。

### 第 5 步：加回归测试锁死

新增 `apps/web/src/test/buttonSystem.test.ts`：

```ts
describe('按钮变体收敛', () => {
  it('只存在 4 个变体', () => {
    const variants = [...css.matchAll(/\.btn--(primary|secondary|ghost|danger)\b/g)]
      .map((m) => m[1]);
    assert.deepEqual([...new Set(variants)].sort(),
      ['danger', 'ghost', 'primary', 'secondary']);
  });

  it('没有独立的按钮类绕过 .btn', () => {
    // 白名单：尚未迁移完成的，每迁一批就删一个
    const legacy = ['.icon-btn', '.send-btn', '.chip'];
    const found = [...css.matchAll(/^\s*(\.[a-z-]*-btn)\s*\{/gm)].map((m) => m[1]);
    const offenders = found.filter((n) => !legacy.includes(n!));
    assert.deepEqual(offenders, []);
  });

  it('按钮规则里没有裸色值', () => {
    const btnBlocks = [...css.matchAll(/\.btn[\w-]*[^{]*\{([^}]*)\}/g)];
    for (const block of btnBlocks) {
      assert.ok(!/#[0-9a-f]{3,8}|rgba?\(/i.test(block[1]!),
        `按钮里出现裸色值：${block[1]}`);
    }
  });
});
```

> 这个测试是**迁移进度的看板**：每迁完一个选择器，从 `legacy` 里删掉它。全部删完 = 迁移完成。

---

## 5. 验收标准

```
[ ] --radius* 旧令牌零命中
[ ] 按钮选择器从 69 个降到 ≤ 12 个（含组件契约自身）
[ ] 每个按钮的 hover 都用 --color-surface-hover（或变体专属令牌）
[ ] 所有按钮高度来自 --h-*，无硬编码 22/26/32px
[ ] 所有按钮圆角来自 --r-sm（或显式 .btn--pill）
[ ] 15 处焦点态收敛为 2 处（.btn / .input）
[ ] buttonSystem.test.ts 全绿
[ ] 逐批人工检查：设置页、侧栏、输入框、弹窗、上下文菜单
```

---

## 6. 顺带要修的 bug 清单

改造过程中发现的、与统一无关但必须一起修的：

| # | 问题 | 位置 | 修法 |
| --- | --- | --- | --- |
| B1 | `button.primary:hover` 用亮蓝 `#5f9aff` | `styles.css` | 改 `var(--color-action-hover)` |
| B2 | `.icon-btn:hover` 用 `rgba(255,255,255,0.06)` | 同上 | 改 `var(--color-surface-hover)`（亮色主题下才正常） |
| B3 | `--radius-lg` → `--r-md`，名实不符 | `:root` | 删掉旧名，统一 `--r-*` |
| B4 | `.attach-btn` 无圆角、字号用了 `--fs-lg` | 同上 | 归入 `.btn--ghost.btn--sm` |
| B5 | `.theme-btn` / `.font-scale-btn` hover 无背景 | 同上 | 用 `.btn--secondary` 的 hover |
| B6 | `.chip` / `.trace-filter-btn` 用裸 padding | 同上 | 用 `--g-*` 或归入 `.btn--sm` |

> B1、B2 是**直接可见的观感 bug**（点击主按钮弹出蓝光、亮色主题下图标按钮出现灰块），建议优先修，不依赖整个改造完成。

---

## 7. 预期收益

| 指标 | 现在 | 改造后 |
| --- | --- | --- |
| 按钮选择器 | 69 | ≤ 12 |
| 焦点态实现 | 15 处 | 2 处 |
| 按钮里的裸色值 | 存在（含 bug） | 0 |
| 新增一个按钮 | 复制改改，再造一个类 | 选变体 + 尺寸，写一个 className |
| 改一次主题 | 逐处修 | 改令牌 |

**最实际的收益**：以后加按钮不再需要"参考旁边那个按钮抄一遍"，而是查表选组合。样式不统一从"靠自觉"变成"结构上做不到"。

---

## 8. 未完成事项与建议

1. **竞品一手视觉资料未获取**（抓取失败）。若需要，建议下一轮：
   - 直接安装 TRAE / DSH / WorkBuddy 截图对比；
   - 或用浏览器工具访问各家官网捕获界面。
   本方案**不依赖**竞品结论即可执行——问题是从我们自己的代码里测出来的。
2. **建议先修 B1/B2 两个观感 bug**（各一行改动），再启动整体改造，让用户马上感受到变化。
3. 改造期间**界面会有一段不一致期**（部分已迁、部分未迁）。建议按批次推进且每批完成后人工过一遍，而不是长时间停在不一致状态。

---

## 9. 一句话总结

> 不是因为"某几处写错了"，而是**缺少按钮组件层**：69 个类各自定义 hover、高度、圆角、字号，且并存两套圆角命名。
>
> 解法不是"统一一下样式"，而是**收敛成 4 变体 × 3 尺寸 + 统一五态**，然后用测试把"再造一个新按钮类"挡住。

---

## 10. 实施结果（2026-11-14）

### 10.1 做完了什么

| 项 | 结果 |
| --- | --- |
| 旧圆角令牌 `--radius*` | **已彻底移除**（含名实不符的 `--radius-lg → --r-md`），30 处引用改写为 `--r-*` |
| B1 主按钮 hover 亮蓝 `#5f9aff` | **已修复** → `var(--color-action-hover)` |
| B2 图标按钮 hover 白色裸值 | **已修复** → `var(--color-surface-hover)`；组件区白色 rgba **8 → 0** |
| `.icon-btn` 蓝色 active 底 | **已修复** → `var(--color-surface-selected)` |
| 按钮契约 `.btn` | **已建立**：5 变体（primary/secondary/ghost/danger/link）× 3 尺寸（sm/md/lg）+ 五态 |
| 组件迁移 | **17 个文件**、约 60 处 className 迁到 `.btn` 契约 |
| 死 CSS 清理 | 删除 **28 条**已迁走的规则 |
| 回归测试 | 新增 `buttonSystem.test.ts`（20 条），锁住变体数量、裸色值、尺寸令牌、旧类残留 |

### 10.2 量化前后

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 控件规则总数（含状态） | 58 | **35** |
| 控件基类 | 22 | **13** |
| 已迁移类的残留 CSS | 9 个类共 28 条 | **0** |
| 半迁移状态（同一样式两套并存） | 存在 | **已消除** |
| 测试 | 577 | **597（全绿）** |

### 10.3 过程中发现的真问题（不是计划内的）

1. **`.msg-action-btn` 迁移会缩小按钮**。原设计 26×26 方形，若直接映射到 `btn--sm`(22px) 会造成尺寸退化——被 `uxFixes.test.ts` 抓到。已补 `.btn--icon-md` 方形档保尺寸。
2. **还有第三批变体没被发现**：`primary` / `ghost` / `link` 以裸类名散落在 40 处，是"按钮有多种变体"的**主体**，比最初识别的 69 个带 `-btn` 后缀的类影响更大。
3. **`.icon-btn.active` 用了蓝色底** `rgba(0,120,212,.18)`，违反"琥珀是唯一高亮"。

### 10.4 未完成

- ~~**输入框契约 `.input`（第 4 步）未做**~~ → **已完成，见 §11**。
- ~~10 个特殊形态控件未迁移~~ → **已完成，见 §12**。
- ~~组件区约 80 处裸色值~~ → **已完成，见 §13**（组件区已清零）。

### 10.5 复现与检查

```bash
# 控件类审计（迁移进度看板）
node scripts/ui-control-audit.mjs

# 运行时 DOM 审计（字号/间距/圆角，需先 pnpm dev）
node scripts/ui-audit.mjs

# 测试（含 20 条按钮体系回归）
pnpm --filter @opencoxswain/web test
```

### 10.6 一条经验

改造中途我用 PowerShell 做文本替换，**破坏了 `styles.css` 与 6 个 tsx 的编码和引号**，靠 `git checkout` 恢复。根因是 PowerShell 的引号转义与 UTF-8 处理不可靠。

**结论：改大文件（尤其中文 + CRLF）一律用 Node 脚本，并每步做花括号平衡与编码校验。** 这比"小心一点"可靠得多。

---

## 11. 输入框契约（第二轮，2026-11-14 完成）

### 11.1 改造前的病态

36 处 `<input>` / `<textarea>` **全部没有 className**，靠父容器的后代选择器定样式。结果是：

| 问题 | 实测 |
| --- | --- |
| 圆角两种 | `.field input` 用 `--r-sm`，`.approval-actions` / `.sidebar-filter` / `.template-form` 用 `--r-md` |
| 内边距四组 | `9px 11px`、`6px 9px`、`5px 8px`、`7px 9px` |
| 焦点态三种 | `.composer` 用 outline；4 处用**改 border-color**（会撑动布局）；`.input` 类根本不存在 |

### 11.2 做法

建立 `.input` 契约（+ `.input--sm` / `.input--bare`），然后**按属性分类**收敛各容器：

- **样式属性**（background / border / border-radius / color / font-family）→ 删除，交给契约；
- **尺寸属性**（padding / font-size）→ 小号场景改用契约值或令牌；
- **布局属性**（flex / min-width / resize / line-height）→ 原样保留，这些是真实差异。

> 没有做整段文本替换——属性差一个就匹配不上。改为解析规则体逐条判断，并统计"删了几条、留了几条"。

### 11.3 结果

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 输入框圆角 | 2 种 | **1 种**（`--r-sm`） |
| 输入框内边距 | 4 组 | **1 组**（令牌） |
| 焦点态实现 | 3 种 | **2 种**（普通 outline / bare 无框） |
| 「改边框的焦点态」 | 4 处 | **0 处** |
| 测试 | 597 | **606（新增 9 条输入框回归）** |

### 11.4 验证

```bash
# 列出所有 input/textarea/select 规则（排查用）
node scripts/list-input-rules.mjs

pnpm --filter @opencoxswain/web test   # 606 全绿
```

### 11.5 一处刻意保留的差异

`.search-input` 和 `.composer textarea` **没有**并入 `.input`：前者是无边框贴容器底、后者是无边框大输入区，形态本就不同。强行统一会把它们变成普通输入框的样子。契约里用 `.input--bare` 表达这类"不要框"的语义，但要改还需要动组件（给 className），下一轮做。

---

## 12. 第三批：剩余 10 个控件（2026-11-14 完成）

### 12.1 先纠正一个判断错误

我最初的分析脚本报告"所有剩余控件使用量为 0"，据此差点判定它们都是死代码。**是检测正则写错了**，用 `Select-String` 复核后发现全都在用（`rail-toggle` 4 处、`view-tab` 5 处、`ui-select-btn` 1 处…）。

> 教训：**"没有使用"这种结论必须有第二种方法复核**，否则会把活代码当死代码删掉。

### 12.2 按形态分三类，不一刀切

| 类 | 控件 | 处理 |
| --- | --- | --- |
| **A 并入契约** | `rail-toggle`（4 处）、`folder-toggle`、`attachment-chip`、`send-btn`（2 处）、`view-tab`（2 处）、`ui-select-btn` | 加 `.btn` 组合类 |
| **B 保留定位类** | 同上 | **加新类、不删旧类**：`btn btn--ghost rail-toggle` |
| **C 不迁移** | `win-btn`（窗口控制，46×30 无圆角）、`welcome-example-pill`（是 `<span>` 不是按钮） | 保持独立，各自形态特殊 |

### 12.3 一个必须记下的错误

第二批迁移时我把 `rail-toggle` 等**定位类整体替换掉了**，导致 6 条测试失败——那些测试靠类名定位组件块（如"开关是否在标题行右侧"）。

**正确做法是「加新类，不删旧类」**：既走契约，又保留定位与语义锚点。已补回并写明原因。

### 12.4 结果

| 指标 | 第一轮后 | 本批后 |
| --- | --- | --- |
| 控件规则总数 | 35 | **18** |
| 控件基类 | 13 | **9** |
| 已迁移类残留 CSS | 0 | **0** |
| 测试 | 606 | **606（全绿）** |

保留的 5 个基类都**有意为之**：`.attachment-chip`（gap/align）、`.rail-toggle.active`（选中色）、`.ui-select-btn`（width: 100% + open 边框）、`.view-tab.active`（选中色）、`.project-folder`（布局），以及不迁移的 `.win-btn`、`.welcome-example-pill`。

### 12.5 三批累计

| 指标 | 改造前 | 现在 | 降幅 |
| --- | --- | --- | --- |
| 控件规则总数（含状态） | 58 | **18** | −69% |
| 控件基类 | 22 | **9** | −59% |
| 独立按钮选择器 | 69 | **契约 12 + 保留 2** | — |
| 测试 | 577 | **606** | +29 |

---

## 13. 第四批：裸色值清零（2026-11-14 完成）

### 13.1 问题

组件区曾有 **约 50 处写死的十六进制 / rgba**，全部是 VS Code 时代的遗留配色：

```css
.win-close:hover { background: #c42b1c; }       /* 红 */
.ctx-menu button:hover { background: #04395e; }  /* 蓝 */
.md-body code { color: #ce9178; }                /* 橙 */
```

它们的实际危害不是"难看"，而是**不会跟随浅色主题切换**——`data-theme=light` 只覆盖了 `--c-*` 色板，这些硬编码值纹丝不动。

### 13.2 处理原则：不是全部换成语义色

分四类，理由不同：

| 类别 | 处数 | 处理 |
| --- | --- | --- |
| 阴影 `rgba(0,0,0,.x)` | 8 | → `--shadow-popover/menu/modal` |
| 遮罩 | 4 | → `--color-scrim` |
| 状态色（失败/成功/警告/信息） | 12 | → `--color-danger/success/warn/info`（含 `-dim`） |
| **代码高亮 / 轨迹分色 / 窗口控制** | 10 | **保留原色，但移入原始层**集中管理 |

> 最后一类刻意**不换成语义色**：代码高亮的橙、轨迹三泳道的蓝/紫/绿、Windows 关窗红，**颜色本身携带信息**。强行语义化会丢掉含义，正确做法是让它们可被主题统一覆盖。

### 13.3 过程中被测试抓到的两次违例

1. `--color-danger-dim: rgba(184,84,80,.15)`——我把它写在了**语义层**，违反"只有原始层写色值"。`tokens.test.ts` 直接报错。已改为色值进原始层、语义层引用。
2. 浅色主题的 `:root[data-theme='light'] .template-picker` 阴影——新写的 `colorDiscipline.test.ts` 把它误判为组件区裸值。核查后确认它是**合法的主题覆写**，修正了检测范围。

### 13.4 结果

| 指标 | 改造前 | 现在 |
| --- | --- | --- |
| 组件区裸色值 | ~50 | **0** |
| 语义层直写色值 | 有 | **0** |
| 测试 | 606 | **619（新增 13 条颜色纪律测试）** |

### 13.5 新增令牌

- 遮罩：`--color-scrim` / `--color-scrim-strong`
- 彩底文字：`--color-on-accent`
- 代码高亮：`--color-code-bg` / `-fg` / `-block` / `-inline`
- 轨迹分色：`--color-trace-user` / `-assistant` / `-tool`
- 阴影：`--shadow-popover` / `-menu` / `-modal`
- 暗淡底色：`--color-warn-dim` / `--color-info-dim` / `--color-danger-dim`

### 13.6 现在切换主题会怎样

`data-theme="light"` 覆盖 `--c-*` 后，**所有组件的颜色都会跟着变**，因为组件区已无任何写死的色值。

> 但浅色主题的**色板本身**仍需人工校对：它是之前就存在的一套值，本轮只保证了"会跟随切换"，没有验证浅色下每一处对比度是否合适。这需要真机截图核对，建议作为独立任务。

### 13.7 验证

```bash
node scripts/list-remaining-colors.mjs   # 应输出 0 处
pnpm --filter @opencoxswain/web test     # 619 全绿
```

---

## 14. 第五批：主题可读性校对（2026-11-14 完成）

### 14.1 为什么要做

第四批让组件区零裸色值，主题"能切了"。但**能切 ≠ 切完还看得清**——
浅色色板是之前就存在的一套值，从未按对比度校对过。

写了 `scripts/audit-theme-contrast.mjs` 做 WCAG 计算，首轮结果：**72 组里 23 组不达标**。

| 主题 | 最严重的问题 |
| --- | --- |
| 深色 | 元信息 `neutral-600` **2.52:1**（需 3.0）、危险色 3.60:1（需 4.5） |
| 浅色 | 元信息 `neutral-600` **1.80:1**（几乎不可见）、次要文字 3.13:1（需 4.5） |

### 14.2 修法：只改原始层

改了 6 个原始色值，语义层与组件**一行没动**——这正是三层令牌的价值。

| 令牌 | 深色 前→后 | 浅色 前→后 |
| --- | --- | --- |
| `--c-neutral-500` | `#7a828b` → `#7d858d` | `#81858c` → `#676a70` |
| `--c-neutral-600` | `#545c65` → `#626971` | `#adb2b8` → `#83878c` |
| `--c-red-500` | `#b85450` → `#c26c69` | — |
| `--c-green-500` | — | `#1f7a4d` → `#1d7248` |
| `--c-amber-500` | — | `#dd8629` → `#c07524` |
| `--c-amber-400` | — | `#c67a12` → `#be7511` |

**结果：72 组全部达标，0 组不达标。**

### 14.3 截图验证抓到了两个静态测试查不出的真实 bug

**这两个问题静态检查完全无法发现，只有真正渲染才暴露。**

#### bug 1：全局 `input` 选择器被误改成 `.input`

前一批插入输入框契约时，我的脚本把**全局 `input {` 改成了 `.input {`**。
由于 36 处 `<input>` 都没有 className，它们全部失去样式——截图里 **API Key 输入框变成浏览器默认白底**，在深色界面上白得刺眼。

修复：基础规则作用于全局 `input` / `select`，变体用 `.input--sm` / `.input--bare`。

#### bug 2：按钮契约被重复插入了 6 次

每个迁移脚本都重新插入一遍 `.btn` 契约，导致文件里有 **6 份**。
后出现的旧版（`color: var(--c-neutral-1000)`）覆盖了修好的版本（`color: var(--color-on-action)`），
所以浅色主题下主按钮文字仍是近黑而不是白色。

修复：去重保留第一份，并新增 `--color-on-action` 语义令牌让两套主题各自决定按钮文字色。

### 14.4 新增的防再生措施

| 工具 | 作用 |
| --- | --- |
| `scripts/audit-theme-contrast.mjs --suggest` | 算 WCAG 对比度并给出建议色值 |
| `apps/web/src/test/themeContrast.test.ts` | 20 条测试：两套主题 × 文字令牌 × 四种表面 |
| `scripts/check-css-structure.mjs` | 真正的括号配对扫描（数量相等≠结构正确） |
| `scripts/screenshot-theme.mjs` | 按主题截图 |
| `scripts/verify-light-theme.mjs` | 在真实浏览器里读取计算样式，验证主题真的生效 |

### 14.5 教训：静态检查救不了 CSS 结构

本批暴露的三个问题（选择器被改名、契约重复 6 次、括号拼坏）**全部通过了测试和类型检查**，
只有"启动 → 渲染 → 读计算值 / 看截图"才发现。

> **CSS 的改动必须真机验证。** 花括号数量相等也不代表结构正确——
> 多一个 `}` 少一个 `{` 会互相抵消，必须做真正的配对扫描。

### 14.6 尚未覆盖

- **不只是设置页**：本轮只截了首屏（设置页）。侧栏、会话区、弹窗、上下文菜单需要逐一截图核对。
- **焦点环、hover、disabled 态**的观感未逐一目检。
- 深色主题的改动较小（3 个色值，均是微调），但同样建议目检一次。

### 14.7 验证

```bash
node scripts/audit-theme-contrast.mjs           # 72 组全部达标
node scripts/check-css-structure.mjs            # 结构完整
pnpm --filter @opencoxswain/web test            # 639 全绿
```

---

## 15. 第六批：真实界面审计（2026-11-15 完成）

### 15.1 为什么静态审计不够

§14 的静态审计只看"令牌组合"，通过了 72/72。
但**真实界面里有 19（深色）+ 23（浅色）处文字对比度不足**。

根因是**用法错配**，不是令牌值本身：

| 令牌 | 设计用途 | 实际被用在哪 | 后果 |
| --- | --- | --- | --- |
| `--c-neutral-600` | 元信息（装饰性） | 侧栏项目状态、底栏标签、引导提示 | 3.08:1，读不清 |

静态审计假设"元信息只要 3:1"，但它在真实界面里承担了**正文级**的职责。
**只有遍历真实渲染的每个文字元素、算出它自己的前景/背景比，才能发现。**

### 15.2 新增工具：`audit-live-contrast.mjs`

在浏览器里遍历所有含文字的元素，对每个元素：
1. 读计算后的 `color`；
2. 向上找第一个不透明背景；
3. 处理半透明前景的叠加；
4. 按字号/字重选阈值（正文 4.5，大字 3.0）。

输出**具体是哪个元素、什么颜色、在什么背景上、差多少**。

### 15.3 修复结果

| 阶段 | 深色 | 浅色 |
| --- | --- | --- |
| 首次审计 | 19 处 | 23 处 |
| 提升 `neutral-600` 后 | 1 处 | 1 处 |
| 修复选中项文字色后 | **0** | **0** |

改动：
- 深色 `--c-neutral-600` `#626971` → `#7e848b`
- 浅色 `--c-neutral-600` `#83878c` → `#676b6f`
- 浅色 `--c-amber-400` `#be7511` → `#985e0e`
- 侧栏文件夹名：`.btn--link` → `.btn--ghost`（**它是导航项，不是链接**，此前继承了琥珀链接色）
- 新增 `.project-folder.active .folder-name { color: var(--color-label-strong) }`

### 15.4 另一批只有截图才能发现的问题

#### 标题栏出现两个「OpenCoxswain」

`title-bar-brand` 写死产品名，`crumb` 又传入了同名的项目名，首屏标题栏显示成 `OpenCoxswain OpenCoxswain`。

修复：面包屑与品牌同名时省略。**这是纯视觉问题，任何测试都不会报。**

#### 浮层遮挡消息区

引导浮层（"试着让它干活"）固定居中，遮住了正在显示的历史消息。
建议：改成可关闭的侧边提示，或首次出现后记住"已读"。

### 15.5 与另一个 Agent 的改动合并

本轮开始时发现 **另一个 Agent 已把我的按钮/输入框体系合进主干**（`57ae474`、`c8a5ebd`），
版本从 v0.102 走到 v0.105.2，测试从 639 增至 698，**双方改动没有互相破坏**：

```bash
node scripts/check-css-structure.mjs   # 结构完整
node scripts/audit-theme-contrast.mjs  # 72 组达标
pnpm --filter @opencoxswain/web test   # 698 全绿
```

> 这正是产品要解决的问题本身：两个执行者并行改同一片区域，
> 需要有人（这里是 C）在合并后**重新验证整套约束**，而不是各自宣布完成。

### 15.6 本批新增的防回退

`apps/web/src/test/tokens.test.ts` 的颜色锁定会在改色时报错——
本轮被它拦下一次（`neutral-600` 改动），**这是它该做的事**。
改色需要：更新锁值 + 写明理由 + 跑 `audit-theme-contrast`。

### 15.7 仍未覆盖

- **会话页/轨迹页/弹窗/右键菜单**未逐页截图（本轮只覆盖首屏与设置页）。
- **hover / active / disabled 态**只验证了 focus（截图里能看到焦点环）。
- 深色主题的浮层、Toast、审批面板未目检。

### 15.8 当前可用的审计工具

| 工具 | 检查什么 |
| --- | --- |
| `ui-control-audit.mjs` | 控件类数量与残留 |
| `list-remaining-colors.mjs` | 组件区裸色值 |
| `audit-theme-contrast.mjs` | 令牌组合的 WCAG 对比度 |
| `audit-live-contrast.mjs` | **真实渲染的元素级对比度** |
| `audit-layout-structure.mjs` | **重复文字、溢出、遮挡** |
| `check-css-structure.mjs` | 括号配对与结构完整性 |
| `screenshot-pages.mjs` / `screenshot-theme.mjs` | 按主题截图 |
