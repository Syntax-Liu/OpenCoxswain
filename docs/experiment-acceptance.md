# 实验记录：验收命令能否"机器可判"

> 日期：2026-11-15
> 目的：验证 `plan-approval.md` §十 的前提——"方案批准后一路做到完，不再逐步问人"。
> 结论：**提示词能显著提高机器可判比例，但"能跑"还需要平台感知，缺了就变成假象。**

---

## 1. 问题从哪来

`plan-approval.md` 的 D2 要求"批准之后不再逐步问用户"。
但当前默认验收策略是 `unverified_only`：只要有一条标准判不了，就 `needsHuman: true`。

实测当前项目里所有 Agent 的验收标准类型：

| 类型 | 数量 |
| --- | --- |
| `human` | **17** |
| `diff` | 1 |
| `command` | 1 |

**19 条里 17 条是 human。** 意味着方案批过后，每完成一步仍会再问一次用户——
直接违反 D2，整个方案的核心承诺落空。

---

## 2. 实验一：改提示词能否提高机器可判比例

根因：`prompt.ts` 里对 criteria 的描述只有一句"强烈建议至少写一条"，
对类型没有任何引导，模型自然挑最容易写的 `human`。

改法：明确要求"优先 command/diff，human 留到最后"，并给出映射示例
（"TypeScript 编译通过" → `pnpm -w typecheck`）。

**同一个模型的对照结果**（三个典型场景，temperature=0）：

| 场景 | 改动前 | 改动后 |
| --- | --- | --- |
| 有明确产出的（改代码） | command=1 diff=1 human=1 | **command=3 human=0** |
| 只读分析的（查问题） | command=0 diff=1 human=3 | command=1 human=1 |
| 纯判断的（调研） | command=0 human=3 | **command=3 human=0** |
| **机器可判比例** | **30%** | **88%** |

**结论：提示词有效。** 而且模型写出的命令质量不差，例如：

```
test -f apps/web/src/components/formatCount.ts &&
  grep -q 'export function formatCount' apps/web/src/components/formatCount.ts
```

---

## 3. 实验二：这些命令**真的能跑**吗（发现的真问题）

上一段的命令看起来很好——但本机是 **Windows**，`cmd.exe` 里
**没有 `test`、没有 `grep`**。

实测：

```
cmd /c "test -f apps/web/src/components/RunnerLane.tsx"
→ 'test' is not recognized as an internal or external command
→ 退出码 1
```

### 3.1 为什么这比"不能用"更危险

验收框架（`acceptance/verify.ts`）用 `exec` 跑命令，**只认退出码**：

- 退出码 0 → `passed`
- 非 0 → `failed`

于是「命令不存在」和「检查没过」**区分不开**：

| 实际发生 | 框架判定 | 用户看到 |
| --- | --- | --- |
| `test -f 存在.md` 但 test 不存在 | failed | "文件不存在"，其实它在 |
| `grep -q 关键内容` 但 grep 不存在 | failed | "内容没找到"，其实有 |

它会**安静地把所有检查判为失败**，看起来像"Agent 没干活"，
而不是"验收命令写错了平台"。排查成本极高。

### 3.2 对照实验

在 criteria 描述里加一段平台说明（当前是 Windows/cmd，列出
`if exist` / `findstr` / `pnpm` / `git` 的写法）：

| | 命令数 | 平台可用 |
| --- | --- | --- |
| 无平台提示 | 4 | **2（50%）** |
| 有平台提示 | 6 | **6（100%）** |

加了提示后模型写出的：

```
if exist apps\web\src\components\RunnerLane.tsx (exit 0) else (exit 1)
findstr /C:"laneStatusOf" apps\web\src\components\RunnerLane.tsx
pnpm --filter web exec tsc --noEmit
git status --porcelain
```

**全部能在本机执行。**

---

## 4. 给 `plan-approval.md` 的修正建议

| 原文 | 建议改为 |
| --- | --- |
| §十「方案里每一步都必须带 command/diff 类验收」 | 补一句：**且命令必须通过平台可用性校验**，不通过就不算机器可判 |
| §十 的表格（command/diff/human 三分类） | 增加第四类：**`command-but-unusable`**（写了命令但本机跑不了），按 human 处理并明确告警 |
| §十一 第 3 步「每步硬验收」 | 实现时加一道校验：`checkCommandUsable()`，不可用的命令**在派活前就退回重写** |

### 一个更根本的建议

不要指望模型每次都写对平台命令。**在派活时就校验**，比事后判 failed 好—— 
派活前发现"这条命令本机跑不了"，让 Assistant 改一版，成本远低于
执行完一轮才发现验收全红。

`scripts/lib/command-portability.mjs` 里已有 `checkCommandUsable()` 的雏形，
可以直接移植进运行时。

---

## 5. 复现方法

```bash
node scripts/experiment-criteria.mjs   # 提示词对机器可判比例的影响
node scripts/experiment-platform.mjs   # 命令的平台可用性
```

两个脚本都用真实模型（deepseek-chat，temperature=0），不需要起服务。
