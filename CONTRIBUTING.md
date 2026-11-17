# 参与开发

谢谢你愿意花时间。这份文档只讲**怎么把它跑起来、改完怎么验证**，不讲产品愿景。

---

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| **Node.js** | **≥ 22** | 见 `package.json` 的 `engines` |
| **pnpm** | 10.x | 仓库用 pnpm workspace，`npm` / `yarn` 装不起来 |
| Rust | 1.77+ | **只有**要构建桌面安装包时才需要 |
| 一个 OpenAI 兼容的模型端点 | — | 需要一个 API Key 才能真跑起来 |

Windows 是主要开发平台（作者在 Windows 上开发）。Linux / macOS 理论可行，但没有 CI 覆盖。

---

## 三分钟跑起来

```bash
# 1. 装依赖
pnpm install

# 2. 构建
pnpm build

# 3. 启动（会打印访问地址）
pnpm runtime --serve
```

浏览器打开它打印的地址，然后在「设置」里填模型密钥（`Ctrl+,`）。

**没有 API Key 也能做的大部分事**：跑测试、改界面、看代码。只有需要真实对话时才要 Key。

---

## 代码地图

```
apps/
  runtime/       产品核心。Node.js，零第三方运行时依赖
    src/
      assistant/   Assistant 会话与派活
      executor/    执行 Agent（含 step.ts：工具调用→人话）
      llm/         模型接入
      security/    沙箱、审批、检查点、快照
      server/      HTTP + SSE
      store/       SQLite 持久化
  web/           React 18 + Vite 前端
    src/
      ui/          **控件层**。新界面一律从这里取组件
      components/  业务组件
      state.ts     状态与事件归并
      styles.css   全部样式（单文件，见下方坑）
  shell/         Tauri 2 桌面壳
legacy/          已归档的旧代码，**不参与构建、不要改**
```

### 先读这两份

- [docs/architecture.md](docs/architecture.md) —— 结构、能力边界
- [docs/glossary.md](docs/glossary.md) —— **命名的唯一权威**。代码、文档、界面、提交信息一律照它

### 要改界面，再读这两份

- [docs/ui-dev-guide.md](docs/ui-dev-guide.md) —— 现状地图、令牌、改造流程、常见坑
- [docs/control-spec.md](docs/control-spec.md) —— 控件唯一真相。**别自己写 `<button>`**

---

## 改完必须跑这些

```bash
pnpm typecheck     # 三个包的类型检查
pnpm test          # 单元测试（约 2000 条，1 分钟内跑完）
pnpm check:self    # 自检：扫"测试全绿但功能不工作"这类问题
pnpm ui:audit      # 界面体检：溢出/遮挡/裁切/裸按钮 + 两主题对比度
```

四条全绿再提 PR。CI 跑的就是这四条。

`pnpm ui:audit` 会真的启动浏览器（用本机 Chrome），需要先 `pnpm build`。

---

## 几个必须知道的坑

### 1. `styles.css` 是单文件，约 6500 行

新样式**追加到最后**，不要插在中间。中间插入会让后面同名的规则覆盖掉它，
排查起来非常痛苦（这个文件里 `.md-body` 曾经定义了 27 次）。

### 2. 换行风格不能变

仓库里 LF 和 CRLF 混着（615 个文件 LF、104 个 CRLF）。
**改一个文件时不许换掉它原本的换行**——否则 diff 会变成整文件重写，评审失效。

`pnpm check:self` 会拦住。被拦了就：

```bash
node scripts/check-eol.mjs --fix
```

它把换行还原成 git 里的样子，内容不动。

### 3. 不用系统默认控件

`<button>`、`<input>`、`<select>` 一律不许直接写。
从 `src/ui/index.ts` 取：`Button`、`TextInput`、`Textarea`、`Field`、`IconButton`……

原因：系统的按钮在不同平台长得不一样，混着用界面就散了。
有测试守着这一条（`controlSpec.test.ts`）。

### 4. 不伪造状态

不显示假进度、不显示假步骤、不做"看起来在干活"的动画。
拿不到真实数据就不显示——**宁可少说，也不要编**。

这条在 [docs/ui-dev-guide.md](docs/ui-dev-guide.md) 里有详细说明，也是审核时会看的东西。

---

## 提交规范

```
<类型>: <一句话说明>

<body：为什么这么改，而不是改了什么>
```

类型用：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`

**正文写"为什么"**。diff 已经能看出"改了什么"，看不出"为什么"。

中文提交信息完全没问题（这个项目的提交历史一直是中文）。

---

## PR

1. 一个 PR 只做一件事。混着改会很难评审
2. 说明里写清：**改了什么、为什么、怎么验证的**
3. 涉及界面的，附一张截图
4. 新增行为请带测试。项目对测试比较认真——现在的测试里有相当一部分
   是在守"不许回退"的规矩（比如上面那些坑）

---

## 遇到问题

- 功能行为不清楚 → 先看 [docs/](docs/README.md) 里对应的说明
- 构建/测试失败 → 先跑 `pnpm check:self`，它会给出具体原因
- 安全相关问题 → 请看 [SECURITY.md](SECURITY.md)，**不要开公开 issue**
