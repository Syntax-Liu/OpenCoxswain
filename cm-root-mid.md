
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
