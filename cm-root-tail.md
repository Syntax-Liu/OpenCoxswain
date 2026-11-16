历史细节（2.5.x 连续 40 个修订号后重排到 3.4.2、已发出的蒲公英构建记录改不了名等）见 [`CourseMeow/README.md`](CourseMeow/README.md) 的「版本号与产物命名规范」。

产物命名：正式分发包为 `CourseMeow-<主.次.修订>.apk`（无 `v` 前缀、无 `-release/-debug` 后缀）。

---

## 五、GitHub 仓库与 CI

> 以下由 `git remote -v` / `git branch -a` / `git tag` 实测确认，仅当前本地状态。

### 两个仓库

| 仓库 | 远程 | 分支 |
| --- | --- | --- |
| 主仓库 `CourseMeow/` | `origin https://github.com/Syntax-Liu/Course-Meow.git` | 只有 `main`（本地 `main` ↔ `remotes/origin/main`） |
| core 抽取仓库（本地副本已归档）`archive/repos-archive/Course-Meow-Core/` | `origin https://github.com/Syntax-Liu/Course-Meow-Core.git` | 仅 `main`；**开源快照**（2026-10-17 首次同步），核心层仍在主仓库持续开发，本仓库暂未跟进同步，后续可能继续同步 |

- 分支命名：只有 `main`，没有 `dev`/`release` 分支。
- 标签命名：`v<主>.<次>.<修订>`，如 `v5.1.0`、`v5.0.1`、`v4.18.1`，按创建时间倒序排列。
- 产物仓库不用版本号标签，固定用 `Android-Latest`。

### workflow 文件

位置：`CourseMeow/.github/workflows/`

| 文件 | 触发条件 | 作用 |
| --- | --- | --- |
| `release.yml`（Release APK） | `push` 标签 `v*` + `workflow_dispatch` | 统一入口；调 `build-apk.yml`，固定 `channel=debug`、`upload_pgyer=true` → **调试版** |
| `build-apk.yml`（Build Release APK） | `workflow_call`（被上面两个复用）+ `workflow_dispatch`（可手选 `channel`：debug / release） | 真正的构建：自测 → 单测 → 读版本 → 抽更新说明 → `assembleRelease` → 权限断言 → 打包进产物仓库 → 调试通道额外 `assemblePerf` 并上传蒲公英 |
| `release-github-only.yml`（Release APK (GitHub Only)） | `workflow_dispatch` | 只进产物仓库、不上蒲公英（`upload_pgyer=false`） |

CI 里的前置关卡（任一失败就拦住出包）：`tools/selftest/run-all.js`、`tools/copy-audit.js`、`tools/check-adapters.mjs`、`tools/replay-adapters.mjs`、`testDebugUnitTest`，以及 **APK 权限断言**——必须有 `INTERNET`、不得有 `CAMERA`（3.4.2 瘦身时 INTERNET 曾被第三方库连带删掉，上线后全网功能不可用）。

### 需要的 secrets（只列名称与用途）

仓库 Settings → Secrets and variables → Actions：

| 名称 | 用途 |
| --- | --- |
| `PGYER_API_KEY` | 上传安装包到蒲公英（账号级 API Key）。未配置时工作流会跳过上传步骤，不影响构建 |
| `GITHUB_TOKEN` | GitHub 内置令牌，CI 用它把安装包写入产物仓库标签 `Android-Latest`。无需手动添加 |

**任何密钥值都不要写进本文档或提交进仓库。**

---

## 六、微信小程序

- 目录：`CourseMeow/miniapp/`（`miniprogram/` 源码、`ci/` 的 `preview.js` / `upload.js` 脚本、`project.config.json`、`package.json`）。
- **源码已随主仓库跟踪**（共 104 个文件，`git status` 无未跟踪项），不另外维护独立仓库。
- **已上线**：用户入口在公众号「诺莱云枢」；小程序码与公众号二维码分别在 `CourseMeow/web/assets/download/nexoraism-miniprogram-qrcode.jpg`、`nexoraism-official-qrcode.svg`。
- 云开发环境与后端接口沿用同一套云端能力。
- 主体备案已完成；用户隐私保护指引需覆盖定位、相册、文件读取权限，后续调整权限时同步更新。
- 审核用测试账号明文只记在 `personal/private/accounts.md`（该目录不入库）；小程序账号与密钥文件位置另行保管（**不要写进文档**）。
- 发布走 `ci/preview.js` / `ci/upload.js`，依赖本地小程序开发者工具与私密配置（不在仓库内）。

---

## 七、常见问题与踩坑

**构建 / 调试**

- 评性能只能用 `perf` 或 `release` 包，**禁止在 debug 包上下结论**（同一份代码 debug 首绘 40~150ms，perf 仅十几毫秒）。
- 调试版通道出的是 `assemblePerf`，不是 `assembleDebug`；要断点调试自己本地打 debug。
- `lintRelease` 的 `NewApi` 不能关，它拦的是 Android 8~13 上的启动崩溃。
- 改了界面文案要同步 `core` 里的四张翻译表（`Lang*.kt`），否则 `copy-audit` 在 `preBuild` 就失败。
- 工具链路径不要含中文；Node 访问 GitHub 需要 `NODE_EXTRA_CA_CERTS=build-tools/ca-bundle.pem`。

**签名 / 安装**

- 签名库固定在仓库里，**不要重新生成**；否则用户无法覆盖升级。
- 调试包与正式包靠 `applicationIdSuffix .debug` 区分，否则蒲公英会把两个包认成同一个应用。

**发版**

- 先 commit 代码再跑 `release.ps1`，它只提交版本三文件。
- 正式版通道必须手动触发，且要等调试版验证通过；不要拿它当「再传一次」用。
- `v*` 标签 = 调试版通道，不是正式版。
- 正式版版本号自成序列；`GitHub API` 推送路径会写出与本地不同的 commit sha（内容一致），必要时 `git fetch && git reset --hard origin/main` 对齐。

**功能红线（容易被改坏）**

- 版本亮点只展示当前版本号，标题统一「版本亮点」；正式版首次启动展示一次。
- 教务导入、日历、自动静音等功能的文案与界面**必须去掉学校专属信息**（校名、教学楼、专属日历名）。
- 导入前有强制免责声明弹窗（需滚到底才能同意，按设备只弹一次）。
- 时间相关功能统一走 `AlarmManager` + 静态广播，重排入口只有 `AppNotifications.reschedule`；上课提醒用 `setAlarmClock` 绕开 Doze 限流。
- 写入系统日历按真实上课日逐条写普通事件，不用 `RRULE`。
- 正方教务解析：`zcmc` 是职称不是周次（周次认 `zcds`）；一卡通必须走教务自己的 CAS 回调，**不要再退回 WebVPN 路线**。
- 桌面小组件：卡片高度随内容自适应并居中；5 个模板顺序固定；点击只响应有底色的卡片本体。
- 数据库文件名 `coursemeow.db` 不要随意改（Room 只认文件名，改名等于换库）。

**原生鸿蒙**

- 原生鸿蒙版本暂不可构建，不要再同步版本、不要再跑鸿蒙发布流程；工程与恢复步骤见 [`CourseMeow/docs/archive/harmony-archive/README.md`](CourseMeow/docs/archive/harmony-archive/README.md)。
- 鸿蒙设备**可通过卓易通安装安卓版 APK 正常使用**，不需要原生鸿蒙包。

---

## 八、文档索引

工程文档的唯一事实源在主仓库 [`CourseMeow/docs/`](CourseMeow/docs/README.md)，完整清单见那份索引：

| 目录 | 内容 |
| --- | --- |
| [`CourseMeow/docs/standards/`](CourseMeow/docs/standards) | 工程规范（语言、报告模板、命名、目录、代码约定、提交与版本） |
| [`CourseMeow/docs/design/`](CourseMeow/docs/design) | UI 设计规范、配色方案、定时与提醒机制、教务接入技术设计、多校适配器设计、验收截图与证据 |
| [`CourseMeow/docs/research/`](CourseMeow/docs/research) | 竞品与生态调研、可行性分析、适配器报告、云端现状报告 |
| [`CourseMeow/docs/guide/`](CourseMeow/docs/guide) | 项目交接文档（部分过时，文首有补记） |
| [`CourseMeow/docs/issues/`](CourseMeow/docs/issues) | 故障复盘、代码体检、官网扫描与收尾盘点 |
| [`CourseMeow/docs/status-report/`](CourseMeow/docs/status-report) | 项目状态总结与发版准备稿 |
| [`CourseMeow/docs/archive/`](CourseMeow/docs/archive) | 仓库内历史归档；含原生鸿蒙工程与发布流程 |

对外内容与素材在 workspace [`docs/`](docs/README.md)：`content/`（官网文案）、`promo/`（公众号推文与视频素材）、`archive/`（非工程历史文档与网页备份）。

模块级文档保留在模块内：`CourseMeow/README.md`（安卓端）、`CourseMeow/cloud/README.md`（云函数）、`CourseMeow/cloud/docs/migrations/`（数据库迁移手册）、`CourseMeow/app/src/main/assets/adapters/*/UPSTREAM.md`（各校适配器上游出处）、`archive/repos-archive/Course-Meow-Core/README.md`（core 层开源快照）。

---
