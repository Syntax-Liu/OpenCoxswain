# 课程表（安卓端）

一个纯本地、离线可用的安卓课程表应用，基于 **Kotlin + Jetpack Compose + Room** 构建。

## 功能清单

### 课程管理
- 添加 / 编辑 / 删除课程：课程名、教师、教学楼、教室、周几、起始/结束节次（支持跨节）、起始/结束周、单双周/自定义周、课程颜色、备注。
- 周视图：格子式课表，课程按节次纵向排布，同时间冲突自动分列；点击课程查看详情，点击空格快速添加。
- 日视图：横向卡片式排布，直接显示课程完整详情（时间、教师、地点、单双周、备注），高亮正在上的课。
- 课程颜色自定义（12 色预设调色板）。

### 时间与学期
- 开学日期设置，自动计算当前第几周。
- 自定义每节课的上下课时间（可增删节次、恢复默认）。
- 周视图按当前时间显示「正在上课 / 下一节」横幅。

### 通知
- 上课前 X 分钟提醒（可自选 5/10/15/30/60 分钟或关闭）。
- 常驻通知栏：白天显示当天剩余课程，当天课程全部结束后自动切换显示第二天课程。

### 桌面小组件
- Glance 小组件：显示今天（或明天）的课程，数据变化自动刷新。

### 数据分享
- 导出：把课表编码成暗号（文本），可复制或分享。
- 导入：粘贴暗号导入，支持「合并到现有课表」或「替换全部」。

### 其他
- 深浅色主题（跟随系统 / 浅色 / 深色）、显示/隐藏周末、课程总数统计。

## 技术栈
- Kotlin 2.0、Jetpack Compose（Material 3）
- Room（本地数据库）、DataStore Preferences（设置）
- Navigation Compose、Lifecycle
- AlarmManager（上课提醒 / 常驻通知刷新）
- Glance（桌面小组件）
- WorkManager（后台周期任务：反馈角标轮询）

## 构建与发布

开发和打包都在 **dev kit** 里完成，不需要装 Android Studio：包里自带 git、JDK 21、
Gradle 8.7 与 Android SDK，整包拷到任何一台 Windows 机器上都能直接出包。
**dev kit 是「怎么构建」的唯一权威** —— 它和本文档冲突时按它来。

下面出现的相对路径都以 kit 根目录为基准；`CourseMeow/` 才是 git 仓库。
本地脚本统一收在 kit 根的 `scripts/` 下（`build-apk.bat`、`github-api.js` 等），
产物（`release-*.apk`、`build-log.txt`、`artifacts/`）仍落在 kit 根。

### 环境要求

- Windows。脚本是 `.bat`，另有少量 `.ps1`。
- **kit 所在路径必须全 ASCII**：`.bat` 走的是 cmd，中文路径会在某些环节直接崩。
- 不需要单独装 JDK / Gradle / Android SDK / Android Studio，全在包里。
- 源码自身的要求：compileSdk 34、minSdk 26（Android 8.0）、targetSdk 34、JDK 21 编译。
- **JDK 必须是 21，和 CI 保持一致**：CI（`.github/workflows/build-apk.yml`）用
  `actions/setup-java` 安装 temurin 21。本机默认 `JAVA_HOME` 可能是更高版本，而 Gradle 8.7
  在 JDK 23+ 上连构建脚本都编译不了（`Unsupported class file major version`），
  Kotlin 2.0.21 在 JDK 27 上会直接报 `Internal compiler error`。
  - 用 `scripts\build-apk.bat` 出包不用额外设置：脚本已把 `JAVA_HOME` 指到包里的
    `build-tools\jdk-21.0.2`。
  - 直接跑仓库里的 `gradlew` 时，在**本机用户级** `%USERPROFILE%\.gradle\gradle.properties`
    写一行 `org.gradle.java.home=<kit>/build-tools/jdk-21.0.2`（路径用 `/` 或 `\\` 均可）。
    仓库内的 `gradle.properties` **不能**写这个绝对路径：Linux CI 上该路径不存在，
    Gradle 会直接启动失败。

### 出一个安装包

```bat
scripts\build-apk.bat
```

它依次做四件事：写 `CourseMeow/local.properties` 指向包里的 SDK → 读
`version.properties` 打印版本 → 清掉上一次的构建产物 → `gradle assembleRelease`。

产物是 kit 根目录的 `release-<主.次.修订>.apk`，完整日志在 `build-log.txt`。
对外交付用的英文名 `CourseMeow-<主.次.修订>.apk` 由 CI 那边产出（见「出正式版」）。

> **顺序不能颠倒：先出包 → 再检验 → 最后才删掉旧包。**
>
> `scripts/build-apk.bat` 打完包**故意不动**旧安装包，就是为这个顺序留余地。检验由工具这边做，
> 不需要真机试装：核对包结构（包名 / versionCode / 三种签名 / dex 里该有的代码与文案）、
> 跑文案体检（`node tools/copy-audit.js`，死键、漏译、重复键三项都要干净）、再看 CI 是否全绿。
> 三项都过了再手删旧的 `release-*.apk`。对外分发的包不在这里 —— 它们在产物仓库
> （GitHub 固定标签 `latest` 的发布，**永远只留最新一版**），本地这些只是自己试装用的。

### 改版本号

在 `CourseMeow` 目录下，用包里的 gradle：

```bat
..\build-tools\gradle-8.7\bin\gradle.bat bumpVersion -Pkind=patch
```

`kind` 取 `major` / `minor` / `patch`，定级规则见下一节。

### 提交并推送

```bat
node scripts\github-api.js push
```

用 `secrets/token.txt` 里的令牌把本地 HEAD 推成远端 `main`，不依赖任何凭据管理器。

脚本会先试 git（走 `github.com`），失败时自动改走 GitHub 的 Git Data API
（`api.github.com`）—— 两条路用的是同一个令牌、推的是同一份内容。这不是多此一举：
有些网络下 `github.com:443` 时通时断（同一个地址这一分钟能出 200、下一分钟就
`Could not connect to server`），而 `api.github.com` 一直稳。换路之后不需要任何
加速器或代理，也就不必为了推代码去开 Steam++ 之类的东西。

也可以直接调那一层：

```bat
node scripts\github-api.js status     :: 远端 main 是哪一条、最近一次出包结果
node scripts\github-api.js push       :: 把本地 HEAD 推成远端 main（只做快进）
node scripts\github-api.js selfcheck  :: 查一下两条路推上去的提交号会不会一致
```

`push` 比对的是两边的**文件树**而不是提交历史，所以就算本地与远端的提交 sha
因为换过推送方式而对不上，它也不会误判；远端上有本地没有的改动时会拒绝推送，
要覆盖得显式加 `--force`。

**已知的一处不完美**：走 API 那次会写出另一个提交号 —— 同样的树、父提交、提交说明
与作者时间，GitHub 返回的 sha 仍然与本地不同（`selfcheck` 就是拿它来复核的）。
内容完全一致，功能也不受影响，只是 GitHub 上会多一条「长得一样」的提交，本地 `git log`
和网页上的历史从此各走一条线。想把本地对齐过去：

```bat
git fetch origin
git reset --hard origin/main
```

顺路一提，`git push` 那条路本身也不是稳定的：同一台机器上 `github.com:443` 大约四次里
通一次，所以脚本才会在它失败后自动换路。

### 出正式版

```bat
node scripts\github-api.js release
```

它会触发 `Build Release APK` 工作流、等它跑完，并核对产物仓库里的版本号。
工作流**只由 `workflow_dispatch` 和 `v*` 标签触发**，普通推送不会自动跑。它会构建、
把包放进产物仓库，并上传蒲公英（没配 `PGYER_API_KEY` 就自动跳过最后一步）。

也一样可以在 GitHub Actions 页面手动触发；两种方式等价。

正式版 Workflow 还会把同一份 `CourseMeow-<版本>.apk` 上传到 CloudBase 静态托管
`/download/CourseMeow-<版本>.apk`，并做 HTTP 200 / content-length / content-type / SHA-256
四项校验，只保留最近 2 个版本 —— 官网下载页的主按钮就指向这里。

同时会生成并上传 `/download/download-meta.json`（版本 / 体积 / SHA-256 / 直链，全部从这份产物算出），
下载页运行时读它渲染，发版不用再手工抄写这几项。`web/assets/site.js` 的 `metaUrl` 首次启用前留空
（线上还没有元数据时页面走兜底、不刷 404）；下次正式发版前设为 `/download/download-meta.json`
并部署站点，release 通道会检查该值，为空直接拒绝发版。**对外分发的 APK 只认 CI 产物**：
本机构建出来的包不上传、不作为下载来源，也没有本地补传脚本；需要换包就重跑 CI。

蒲公英的下载页与二维码跨版本固定，测试用户只认这一条链接，不用每出一版换一次。

一键做完全套就是先后两条命令：`node scripts\github-api.js push` 再 `node scripts\github-api.js release`。
云端构建成功后会把包放进产物仓库，并自动上传蒲公英；本地那份旧 `release-*.apk` 自己手删即可。

### 本地自测

改完代码，尤其动过支付、文案或版本号之后，本地先跑一遍：

```bat
:: 服务端逻辑自测（通道白名单、开关、验签串等纯函数）
node tools\selftest\run-all.js

:: 文案体检：死键 / 漏译 / 重复键
node tools\copy-audit.js
```

### 构建过程里的两道关卡（别绕过）

- `preBuild` 会跑 `tools/copy-audit.js`：界面上每句写死的中文都得在四张翻译表里有译文，
  否则其他语言下会直接显示中文。
- `assembleRelease` 会跑 `lintRelease`，且只启用 `NewApi` 检查并 `abortOnError`。
  这条关卡拦的是「用了高于 minSdk 的 API」：之前 `LocalDate.ofInstant`（要 API 34）
  让 Android 8~13 一启动就崩，全线炸过一回，所以留着它。

## 版本号与产物命名规范

版本号是「主.次.修订」三段式的语义化版本。唯一来源是根目录的 `version.properties`，
用 `gradle bumpVersion -Pkind=...` 迭代；界面上的版本直接读 `BuildConfig.VERSION_NAME`，
所以「打包出来的版本」与「界面上显示的版本」永远一致。按改动的性质定级：

| kind | 什么时候用 | 例子 |
| --- | --- | --- |
| `major` | 不兼容变更：让还在用的旧版本失效 | 0.44.2 → 1.0.0 |
| `minor` | 向下兼容地新增功能 | 0.4.2 → 0.5.0 |
| `patch` | 向下兼容地修复 / 调整 | 0.5.0 → 0.5.1 |

判定的唯一标准是「有没有让旧版本失效」：改了登录 / 注册方式、改了接口入参、
去掉了某个功能，都算不兼容 —— 用户手上的旧包在新服务端上会报错或少能力，
必须升主版本号。

> **2026-10-11 校正过一次历史编号**：2.5.0 之后连着走了 40 个修订号（2.5.1 ~ 2.5.40），
> 中间新增的功能一直没有升次版本号。现已按上面的规则整条重排（2.5.1 → 2.6.0、
> 2.5.12 → 2.9.0、2.5.24 改了登录方式 → 3.0.0 …… 收尾在 3.4.2）。
> 重排只改了版本日志与文档里的号；**已经发出去的安装包改不了名**（蒲公英上的构建记录仍是旧号），
> 两者对不上时以版本日志里的号为准。

产物命名规定为 **`CourseMeow-主.次.修订.apk`**，例如 `CourseMeow-1.0.0.apk`：
不带 `v` 前缀，也不带 `-release` / `-debug` 之类的后缀，版本号三段都不能省。
中文名叫「拾课喵」，它的英文写法就是 CourseMeow，对外分发统一用英文名 ——
别写成拼音 shikemiao，那等于同一个东西的第二种拼法，容易和下载页对不上。

（dev kit 本机打包产出的是 `release-<版本>.apk`，只用于本机核对与安装；
对外交付的那份由 CI 按上面的规则命名。）

云端相关的部署说明见 [`cloud/README.md`](cloud/README.md)。

## 目录结构
```
CourseMeow/
├── app/src/main/
│   ├── AndroidManifest.xml
│   ├── java/com/nexoraism/coursemeow/
│   │   ├── MainActivity.kt              # 入口
│   │   ├── CourseMeowApp.kt            # Application + 作用域
│   │   ├── AppVersion.kt                # 版本日志（唯一来源，蒲公英更新说明也取自这里）
│   │   ├── data/                        # Room 实体/DAO/设置仓库、云端仓储、翻译表
│   │   ├── domain/                      # 核心计算（周次、当前课程、编解码）
│   │   ├── notification/                # 通知、闹钟调度、广播接收器
│   │   ├── dev/                         # 崩溃自查页、运行日志
│   │   ├── widget/                      # Glance 桌面小组件
│   │   └── ui/                          # 周视图、日视图、编辑、设置、会员、反馈、导入导出
│   └── res/                             # 资源（主题、图标、小组件配置）
├── cloud/                               # 云函数与部署说明（见 cloud/README.md）
├── keystore/                            # 正式签名库（本地与 CI 共用同一把）
├── tools/                               # 文案体检、清单生成、发布说明抽取、自测
└── gradle/libs.versions.toml            # 依赖版本目录
```

> 包名统一为 `com.nexoraism.coursemeow`：`namespace`（源码与 R 类的归属）和
> `applicationId`（装在手机上的那个）**现在是同一个值**，不要再让它们分叉 ——
> 历史上一个 `com.syntax` 一个 `com.nexoraism`，2026-10 已经统一。
>
> 数据库文件名从 `coursetable.db` 改成了 `coursemeow.db`。**这次没有做旧文件搬迁**：
> 改名的当下本地没有任何需要保留的数据，就没留那套兼容代码 —— 从 2.6.2 及更早版本
> 直接升上来的设备，本地课表会是空的（云端备份不受影响）。将来再动这个名字要想清楚：
> Room 只认文件名，换个名字就等于换了一个库，旧数据仍在磁盘上但永远读不到。

## 权限说明
| 权限 | 用途 |
| --- | --- |
| POST_NOTIFICATIONS | 上课提醒、常驻通知（Android 13+ 需授权） |
| SCHEDULE_EXACT_ALARM | 精确时间上课提醒（Android 12+ 需在系统「闹钟和提醒」中手动开启，否则自动降级为不精确提醒） |
| RECEIVE_BOOT_COMPLETED | 重启后自动恢复提醒排期 |
| ACCESS_COARSE_LOCATION | 天气（按城市取天气，开关关闭时不读取；可选，可不授权） |
| REQUEST_INSTALL_PACKAGES | 应用内检查更新后拉起系统安装器 |
| VIBRATE | 提醒震动 |

## 常见问题
- **收不到上课提醒**：确认已授予通知权限；Android 12+ 还需在系统设置中允许「闹钟和提醒」的精确闹钟访问。
- **常驻通知不显示**：在「设置 → 常驻通知栏」中开启，并保证通知权限已授予。
- **导入的课程时间不对**：导入只包含课程本身，开学日期与上下课时间需在本机自行设置。