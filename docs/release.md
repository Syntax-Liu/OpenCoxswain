# 发布与自动更新

## 一、自动更新怎么工作

```
用户机器                        GitHub Releases
   │                                  │
   ├─ 启动时检查 ────────────────────→ latest.json
   │                                  │
   │  ← version / url / signature ────┤
   │                                  │
   ├─ 用内置公钥校验签名 ─────────────┤  ← 对不上就拒绝安装
   │                                  │
   └─ 通过 → 下载 → 安装 → 重启
```

**签名的意义**：只有拿着私钥的人才能产出能通过校验的安装包。
即使 GitHub 账号被盗、下载地址被替换，用户机器上也不会装上一个假包。

## 二、密钥（最重要）

### 现状

| 项 | 位置 | 是否入库 |
| --- | --- | --- |
| **公钥** | `apps/shell/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` | ✅ 入库（本来就该公开） |
| **私钥** | `%USERPROFILE%\.opencoxswain\updater.key` | ❌ **绝不入库** |

### 铁律

> **私钥丢了 = 所有已发布版本的自动更新全部失效。**

因为客户端内置的公钥校验的是用这把私钥签的包。换新私钥意味着：
老版本用户永远不会收到更新（他们的客户端只认旧公钥），只能让用户手动装新版。

所以：

1. **立刻把私钥备份到密码管理器**（1Password / Bitwarden 的安全笔记等）；
2. 不要放进仓库、不要贴进聊天、不要放进 CI 日志；
3. 开源后 CI 里用 **GitHub Secrets** 注入，不要写进 workflow 文件。

### 重新生成（仅在确认要换钥匙时）

```bash
pnpm --filter @opencoxswain/shell exec tauri signer generate -w %USERPROFILE%\.opencoxswain\updater.key --ci
```

生成后把 `.pub` 的内容填进 `tauri.conf.json` 的 `pubkey`，**并接受老用户无法自动更新**。

## 三、发布流程

```bash
node scripts/version.mjs bump minor     # 0.9.1 → 0.10.0
pnpm test                               # 必须全绿
build-app.cmd                           # 出包（会自动带上签名与 latest.json）
```

产物在 `apps/shell/src-tauri/target/release/bundle/nsis/`：

```
OpenCoxswain_<版本>_x64-setup.exe       安装包
OpenCoxswain_<版本>_x64-setup.exe.sig   签名
latest.json                             更新清单
```

然后到 GitHub 建一个 **tag 形如 `v0.10.0`** 的 Release，把上面三个文件**一起**上传。

> ⚠️ `latest.json` 里的下载地址是 `releases/download/v<版本>/...`，
> 所以 **tag 名必须是 `v<版本>`**，否则更新下载会 404。

当前更新地址配置在 `tauri.conf.json`：

```
https://github.com/Syntax-Liu/OpenCoxswain/releases/latest/download/latest.json
```

`latest` 会自动指向最新的那个 Release。

### 发布前先本地验证一次

不用真的发 Release 就能验证整条链路：

```bash
# 终端 1：起本地更新服务器（行为与 GitHub Releases 一致）
pnpm release:serve --port 47800

# 终端 2：验证下载 + 验签 + 篡改检测
pnpm release:verify
```

期望输出 14 项全过，包括：

- 正版安装包**通过 Ed25519 验签**
- 篡改安装包 / 篡改签名 / 换公钥 → **全部被拒绝**

### 验签的两个坑（花了很久才对，别再踩）

**坑 1：签名在 blob 的偏移 10，不是 0。**

```
签名 blob（74 字节）：
  [0..2)   "ED" 或 "Ed"   算法标识
  [2..10)  keyId
  [10..74) 64 字节签名      ← 这里
```

**坑 2：`ED`（大写）是预哈希模式。**

Tauri 用 `ED`，意思是对 **BLAKE2b-512 后的哈希**做 Ed25519，不是直接对文件内容。
用 `Ed` 的方式去验会一直失败，而且报错看起来像"签名与文件不匹配"，
很容易误判成密钥问题——我第一次就误判了，还差点去查私钥。

```js
const payload = algorithm === 'ED'
  ? createHash('blake2b512').update(content).digest()  // 预哈希
  : content;
```


## 四、关于 SmartScreen（重要，别让用户以为中了病毒）

安装包**没有代码签名**（那需要几千元/年的 EV 证书 + 企业资质）。所以用户首次运行会看到：

> Windows 已保护你的电脑
> Microsoft Defender SmartScreen 阻止了无法识别的应用启动

这是**信誉不足**，不是检测到病毒。用户需要点：

```
更多信息  →  仍要运行
```

**必须在 README 里写清楚这一步**，否则大量用户会以为软件有问题而放弃。
这是没有代码签名的必然代价，不是可以靠技术绕过的东西。

> 说明：自动更新的**签名**（minisign）和 Windows 代码签名是**两件不同的事**。
> 前者保证"更新包是你发的"，后者保证"Windows 信任这个发布者"。
> 我们做了前者，没做后者。

## 五、CI 里怎么配（开源后）

在仓库 Settings → Secrets 里加：

| Secret | 值 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 私钥文件的**完整内容** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 若密钥带密码则填，无密码留空 |

workflow 里引用 `${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}`，
**不要在 workflow 文件里写明文密钥**。

## 六、还没做的

| 项 | 说明 |
| --- | --- |
| 安装包代码签名 | 需要 EV 证书；不做就一直有 SmartScreen 提示 |
| 自动发布到 Releases | 目前手动上传三个文件；开源后可加 GitHub Actions 自动做 |
| 增量更新 | 每次都是完整安装包（24MB），可接受 |
