
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