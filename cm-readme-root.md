# 拾课喵（CourseMeow）

一个纯本地、离线可用的安卓课程表应用，中文名「拾课喵」，对外分发统一使用英文名 `CourseMeow`（不要写成拼音 `shikemiao`）。

本文件是**整个 workspace 的总入口**：说明有哪些端、代码放在哪、怎么构建、怎么发版。安卓端自身的功能清单等细节见 [`CourseMeow/README.md`](CourseMeow/README.md)。

---

## 一、端侧构成

| 端 | 目录 | 状态 |
| --- | --- | --- |
| 安卓端（主） | `CourseMeow/app` + `CourseMeow/core` | **在维护，唯一在发版的端** |
| 微信小程序 | `CourseMeow/miniapp` | 已上线，源码随主仓库跟踪；入口见第六节 |
| 原生鸿蒙版 | `CourseMeow/docs/archive/harmony-archive/harmonyApp` | **已归档（2026-11-07）**，暂不可构建、不发布；鸿蒙设备可通过卓易通安装安卓版 APK 正常使用 |
| 云端（可选能力） | `CourseMeow/cloud` | 云函数：账号、支付（`account` / `pay`），部署见 [`cloud/README.md`](CourseMeow/cloud/README.md) |
| 官网/落地页 | `CourseMeow/web` | 下载页、隐私政策、用户协议等静态页 |

三条硬约束（别踩）：

- **原生鸿蒙版本暂不可构建**：工程、专属文档与发版脚本里的版本同步逻辑已在 2026-11-07 移入 `CourseMeow/docs/archive/harmony-archive/`，不要恢复或同步版本号。**鸿蒙设备仍可通过卓易通安装安卓版 APK 正常使用**，不是「鸿蒙完全不可用」。
- **版本号只跟安卓端走**，不再与原生鸿蒙版本保持一致。
- **发布流水线只保留安卓端**，`v*` 标签触发的流程里没有鸿蒙任务。

> 原生鸿蒙归档清单、措辞口径与恢复步骤见 [`CourseMeow/docs/archive/harmony-archive/README.md`](CourseMeow/docs/archive/harmony-archive/README.md)。

---

## 二、本地仓库结构

⚠️ **workspace 根目录本身不是 git 仓库**，里面是两个互相独立的仓库：

```
d:\Users\37632\Products\CourseMeow\        ← workspace 根（不是 git 仓库）
├── CourseMeow/                ← 主仓库（git），安卓端 / core / cloud / miniapp / web / CI
├── archive/repos-archive/Course-Meow-Core/ ← core 抽取仓库的本地归档副本（2026-11-05 起；core 层只认 CourseMeow/core）
├── docs/                      ← 对外内容与素材（content/promo）＋非工程归档；工程文档在 CourseMeow/docs/
├── scripts/                   ← 本机工具脚本（不进任何仓库，路径全部相对 kit 根推导）
│   ├── build-apk.bat          ← 本地出一份 release 包（试装用）
│   ├── 试装.bat                ← 出包并 adb 安装到已连接的手机
│   ├── 发布蒲公英.bat          ← 从产物仓库取包手动发一次蒲公英
│   ├── github-api.js          ← 推送 / 触发 CI / 查看状态
│   └── 云端体检.bat / .js      ← CloudBase 后端只读体检
├── build-tools/               ← dev kit：JDK 21、Gradle 8.7、Android SDK、Node、CA 证书
├── personal/                  ← 个人对外资料唯一事实源（昵称、头像、链接、备案、产品口径），见 personal/README.md
├── secrets/                   ← 本地凭据（token、蒲公英 key 等），见 secrets/README.md
├── reference/                 ← 上游参考资料（各自独立 git 克隆，只读快照）
├── archive/                   ← 仍在但当前不用的资料与旧产物（见 archive/README.md）
├── artifacts/、tmp/、sdcard/   ← 临时/归档产物，可清理
├── .gitignore                 ← 只在「真的把 workspace 根入 git」时才生效，见文件内注释
└── README.md、docs/            ← 本文件与文档索引
```

主仓库 `CourseMeow/` 内部：

```
CourseMeow/
├── app/                    # 安卓应用模块（Compose UI、入口、小组件、通知）
├── core/                   # 纯 Kotlin 核心层（解析、计算、数据模型、翻译表），可有自己的单测
├── cloud/                  # 云函数与部署说明（account / pay）
├── miniapp/                # 微信小程序（已上线，源码随仓库跟踪，见第六节）
├── web/                    # 官网静态页
├── keystore/               # 固定签名库（本地与 CI 共用同一把）
├── tools/                  # 自测、文案体检、适配器校验、发版脚本 release.ps1 / 发调试版快.ps1
├── out-adapters/           # 适配器产物/导出
├── docs/                   # 模块内文档与归档（archive/harmony-archive/ 等）
├── gradle/libs.versions.toml
├── .github/workflows/      # CI：release.yml / build-apk.yml / release-github-only.yml
├── version.properties      # 版本号唯一来源
├── README.md               # 安卓端说明（模块级主文档）
└── TODO.md                 # 待办清单
```

文档分两处：**工程文档**（规范、设计、调研、缺陷/审计、交接、发版记录）的唯一事实源在主仓库 [`CourseMeow/docs/`](CourseMeow/docs/README.md)，随代码入库；**对外内容与素材**（官网文案、公众号推文、非工程归档）在 workspace 根 [`docs/`](docs/README.md)。详见第八节。

---

## 三、环境与构建

### 环境要求

- **Windows**（脚本是 `.bat` / `.ps1`；CI 在 `ubuntu-latest` 上跑）。
- **JDK 21**：CI 用 temurin 21；本机 dev kit 在 `build-tools/jdk-21.0.2`。
- **Gradle 8.7**：仓库自带 wrapper（`CourseMeow/gradlew.bat`），本机另一份在 `build-tools/gradle-8.7`。
- **Android SDK**：`build-tools/android-sdk`，需要 platform 34 + build-tools 34.0.0。本地用 `scripts/build-apk.bat` 时会自动写 `local.properties`。
- 源码参数：`compileSdk 34`、`minSdk 26`（Android 8.0）、`targetSdk 34`；Kotlin/Java 编译目标 17，**用 JDK 21 编译**。
- ABI 只打 `arm64-v8a` + `armeabi-v7a`（debug 变体额外带 `x86_64` 供模拟器）。
- **工具链所在路径不要用中文**：`.bat` 走 cmd，中文路径会在部分环节直接崩。

不必装 Android Studio；dev kit 整包拷到另一台 Windows 机器即可出包。

### 签名

仓库里固定一把 keystore：`CourseMeow/keystore/桃花坞里柳边风.jks`（别名 `CourseMeow`，v1/v2/v3 全开），**debug / perf / release 共用这一把**，本地与 CI 也是同一把，所以两边出的包能互相覆盖安装。

- **绝对不要现场 `keytool -genkeypair` 生成新密钥**：签名对不上，Android 会直接拒绝安装（表现为「应用未安装」，且不报原因）。
- 本地配置：`secrets/token.txt`（GitHub PAT，供 `scripts/github-api.js` 用）、`secrets/pgyer.txt`（蒲公英 API Key 备份）。目录说明见 [`secrets/README.md`](secrets/README.md)。这些文件**不要提交、不要外传**。

### 常用命令

在 `CourseMeow/` 目录下执行（`gradlew.bat`）：

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| **调试版出包**（给人试用、上蒲公英调试通道） | `gradlew.bat assemblePerf` | 产物 `app/build/outputs/apk/perf/app-perf.apk`。包名同 debug（`…​.debug`）、签名与自更新地址相同，但 `debuggable=false`，性能与正式版一致 |
| **仅断点调试** | `gradlew.bat assembleDebug` | 产物 `app-debug.apk`。可调试包在 ART 里几乎全靠解释/JIT，首绘 0.3~0.6ms/元素，**不要拿它评性能、不要发给别人试** |
| **正式版** | `gradlew.bat assembleRelease` | R8 开、资源压缩开、**混淆不开**（混淆会让崩溃堆栈变成 `a.b.c`，没法排查） |
| 单测 | `gradlew.bat testDebugUnitTest` | CI 也会跑 |
| 升版本 | `gradlew.bat bumpVersion -Pkind=patch` | `kind` ∈ `major/minor/patch`，只改 `version.properties` |
| 自测与校验 | `node tools/selftest/run-all.js`<br>`node tools/copy-audit.js`<br>`node tools/check-adapters.mjs`<br>`node tools/replay-adapters.mjs` | 服务端纯函数自测、四语文案体检、适配器静态门槛、A 类适配器回放 |

便捷脚本（多数在 workspace 根的 `scripts/`，`发调试版快.ps1` 在 `CourseMeow/tools/`；路径均自动推导，双击或在该目录执行均可）：

- `scripts/build-apk.bat`：本机打一份 `release-<版本>.apk` 用于试装（**不**对外分发）。
- `CourseMeow/tools/发调试版快.ps1 -Bump patch -Notes "..."`：可选升版本 → 本机 `assemblePerf` → 直传蒲公英调试应用，打印下载页。跳过了 CI 的自测/单测/权限断言，只适合调试版。
- 脚本执行中生成的 `release-*.apk`、`build-log.txt`、`artifacts/` 仍落在 kit 根，不在 `scripts/` 下。

构建自带两道关卡：`preBuild` 跑文案体检（界面写死的中文必须在四张翻译表里有译文）；`assembleRelease` 跑 `lintRelease`（只开 `NewApi` 并 `abortOnError`，拦「用了高于 minSdk 的 API」——历史上 `LocalDate.ofInstant` 让 Android 8~13 一启动就崩过）。

---

## 四、版本与发布

### 两处版本号

| 文件 | 含义 |
| --- | --- |
| `CourseMeow/version.properties` | **唯一来源**：`versionMajor` / `versionMinor` / `versionPatch`；`versionCode = major*10000 + minor*100 + patch` |
| `CourseMeow/app/src/main/java/com/nexoraism/coursemeow/AppVersion.kt` | 版本日志 `VersionLog`，**应用内「版本日志」与蒲公英更新说明都取自这里** |

当前版本（以 `version.properties` 为准）：`5.2.0`，对应 `versionCode = 50200`。

`tools/release.ps1` 会一次改上面这两个文件（连同版本日志中「当前版本」标记的顺延），所以不要只手改 `version.properties`。

### 两条通道

| 通道 | 触发方式 | 出什么包 | 上哪 |
| --- | --- | --- | --- |
| **调试版** | 推 `v*` 标签自动触发（`release.yml`，`channel=debug`, `upload_pgyer=true`） | `assemblePerf`（perf 包） | 蒲公英**调试**应用 + 产物仓库标签 `Android-Latest` |
| **正式版** | **手动** Run `build-apk.yml`，通道选 `release` | `assembleRelease` | 蒲公英**正式**应用 + 产物仓库标签 `Android-Latest` |
| **自托管直链** | 随正式版 `channel=release` 自动执行（`build-apk.yml` 的「Upload self-hosted APK」） | `CourseMeow-<版本>.apk` + `download-meta.json` | CloudBase `/download/`：上传 → 200 / content-length / content-type / SHA-256 四项校验 + 元数据逐字段校验 → 只保留最近 2 个版本 |

- **正式版必须等调试版验证通过后再手动触发。** 手动跑 release 通道会拿当前 `version.properties` 的版本号直接覆盖正式蒲公英——这个顺序搞错过一次（把 4.0.9 直接推成了正式版），别再犯。
- **对外分发的 APK 只认 CI 产物。** 下载页的版本 / 直链 / 体积 / SHA-256 运行时读 `/download/download-meta.json`（由 CI 从同一份构建产物算出），发版收尾只需更新 `site.js` 的发布文案（`releaseDate / releaseSummary / points / log`），不用再抄写这四项。首次启用前 `metaUrl` 留空（避免线上请求 404），下次正式发版前打开并部署，release 通道会强制检查。本机构建包不上传、不作为下载来源，也没有本地补传脚本（`tools/upload-apk.ps1` 已删除）；需要换包就重跑 CI。
- 只上 GitHub、不上蒲公英时用 `release-github-only.yml`（`upload_pgyer=false`）。
- 蒲公英两个应用按**包名**归属、互不覆盖：正式 `com.nexoraism.coursemeow`（短链 `CourseMeow-Android`），调试 `com.nexoraism.coursemeow.debug`（短链 `CourseMeow-Android-debug`）。
- 产物仓库固定标签 `Android-Latest`，**永远只留最新一版**（每次先删旧附件再传新的）。

### 发版脚本 `CourseMeow/tools/release.ps1`

流程：升版本 → 改版本三文件 + 版本日志 → **只提交这几个版本文件** → 打 `v<主.次.修订>` 标签 → 推送（推送后 CI 自动跑）。

- ⚠️ **它只提交版本相关文件，不会带上你的代码改动。** 发版前若工作区还有未提交的修复，**必须先自己 commit**，否则标签指向的 commit 里没有那些修复，CI 构建出来的就是没修复的包。
- 本地工作区有未提交改动时也能跑，但结果同上：那些改动不进包。

### 应用内自更新

`BuildConfig.PGYER_PAGE_URL` 由 `app/build.gradle` 按 buildType 区分：

- `debug` / `perf` → `https://www.pgyer.com/CourseMeow-Android-debug`
- `release` → `https://www.pgyer.com/CourseMeow-Android`

不要改成写死一个地址：两版版本号一致时，调试包会去读正式主页，被判定「没有新版本」，应用内就下不了更新。

### 版本号定级

`major` = 不兼容变更（旧版本在新服务端上失效/报错）；`minor` = 向下兼容的新功能；`patch` = 修复与调整。判断标准只有一个：**有没有让旧版本失效**。

**正式版版本号自成序列**，不照搬调试版：调试版的号可以随便飘；发正式版时以上一次正式版为基准，把自那以来的所有改动合并当**一次**更新，按总更新量定 major/minor/patch。

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

