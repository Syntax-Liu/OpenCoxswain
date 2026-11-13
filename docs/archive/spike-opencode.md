# OpenCode Windows Spike（v0.3.0）

> 目的：在接入 `runtime.opencode` 之前，确认 OpenCode 在 Windows 上的可执行形态、事件流、隔离方式与失败边界。结论均来自本机实测，不是推测。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| Node | 24.20.0（`engines >= 22`） |
| OpenCode Desktop | 2.2.6（已安装） |
| 桌面版 CLI | `%APPDATA%\ai.opencode.desktop\cli\2.2.6-x64\opencode-cli.exe` |
| 常驻服务 | OpenCode Desktop 自带 service，占用 127.0.0.1:28894 |
| 数据目录 | `~/.local/share/opencode/opencode.db`（由桌面版持有，旧 schema） |

## 2. 结论（先说结果）

**可行。选择桌面版 CLI 的 `run --standalone --format json` 路线，不需要 HTTP 服务，不需要用户 API Key。**

已验证：

- 真实创建/修改文件、`git status` 能看到变更；
- 逐行 JSONL 事件可稳定解析；
- 默认免费模型可用，`step_finish` 上报 `cost=0`；
- 设置四个 XDG 环境变量后，会话与数据库完全隔离到私有目录；
- 只读角色可用 `--agent plan` 强制不写文件。

## 3. 两条候选路线与取舍

### 3.1 HTTP `serve`（未采用）

`opencode serve --port <p>` 可启动私有服务：

- `/global/health` → `{"healthy":true,"version":"1.19.5"}`
- `/doc` → OpenAPI 文档
- `/event` → SSE 事件流
- `/session`、`/session/{id}/message`、`/session/{id}/abort` 可用

未采用原因：

1. 需要自己管理服务生命周期、端口与重连；
2. CLI 已提供等价的事件流，单进程模型更贴合 `RuntimeAdapter` 的「一次会话一个子进程」；
3. 少一层 HTTP 与鉴权，Windows 进程清理也更直接。

HTTP 路线保留为**替代路线**：如果 CLI 的 JSONL 格式在升级中破坏，可改走 `serve` + SSE。

### 3.2 CLI `run`（采用）

```powershell
opencode-cli.exe run --standalone --format json "<prompt>"
```

- `--standalone` 必需：不带该参数时，CLI 会尝试复用/抢占桌面版 service 的 28894 端口，直接失败。
- `--format json` 输出逐行 JSONL，每行结构：

```json
{ "type": "step_start|text|tool_use|step_finish", "timestamp": 0, "sessionID": "ses_...", "part": {} }
```

| type | 可用字段 |
| --- | --- |
| `text` | `part.text.text` |
| `tool_use` | `part.tool`、`part.state.input`、`part.state.output`、`part.state.status` |
| `step_finish` | `part.cost`、`part.tokens.input`、`part.tokens.output` |

- `--agent plan` 为只读模式，实测模型会明确拒绝写文件；实施/写作角色使用默认 build agent。
- `--model <provider/model>` 可指定模型；不传则使用当前默认模型（实测免费，`cost=0`）。

## 4. 必须避开的坑

### 4.1 不要用 npm 的 `opencode-ai@1.19.5`

`npm i -g opencode-ai` 得到的是 **1.19.5**，它读取同一个 `opencode.db` 时报：

```
Database is not empty and has no session table
```

桌面版 2.2.6 的数据库 schema 已升级，旧 CLI 不兼容。**必须使用桌面版自带的 `opencode-cli.exe`**。

`/global/health` 返回的 `version: 1.19.5` 是应用 semver，不是 CLI 包版本，不能据此判断版本。

### 4.2 非 `--standalone` 会抢占端口

桌面版常驻 service 已监听 28894。不带 `--standalone` 的子进程会尝试连同一个服务/端口并失败。适配器固定加 `--standalone`。

### 4.3 数据目录必须隔离

默认会读写用户的 `~/.local/share/opencode`、`~/.config/opencode` 等。适配器为每个会话创建私有目录，并注入：

```
XDG_DATA_HOME
XDG_CONFIG_HOME
XDG_CACHE_HOME
XDG_STATE_HOME
```

实测四项都生效；会话数据库、缓存不会污染用户全局数据。

## 5. 适配器映射

| OpenCode JSONL | `RuntimeEvent` |
| --- | --- |
| `step_start` | 忽略（仅表示步骤开始） |
| `text` | `message`（`part.text.text`） |
| `tool_use` | `tool_call` + `tool_result`（`part.tool` / `state.input` / `state.output`） |
| `step_finish` | 累计 `cost`、`tokens.input/output`，不发事件 |
| 进程非零退出 | `error`（带 stderr 尾部，`retryable: true`） |
| 超时 / 取消 | 终止进程树，不发 `finished` |

进程结束后由适配器统一：

1. `git add -A` + commit（只读角色不提交）；
2. 逐条判定 `acceptance_criteria`（command / diff）；
3. 生成 `diff.patch` 与校验报告产物；
4. 汇总成本（`usd` 取 `step_finish` 累加，`minutes` 取墙钟时间）；
5. 原始 JSONL 写入产物目录 `opencode.jsonl`，作为 `logsRef`。

## 6. 二进制发现顺序

1. `OPENCOXSWAIN_OPENCODE_BIN`（显式路径，最高优先级）；
2. `%APPDATA%\ai.opencode.desktop\cli\<version>-x64\opencode-cli.exe`（取最高版本）；
3. PATH 中的 `opencode`。

`healthCheck()` 执行 `<bin> --version`，输出形如 `opencode v2.2.6`。找不到二进制时返回 `{ ok: false, detail }`，不会导致 Daemon 启动失败。

## 7. 失败与替代路线

| 失败形态 | 处理 |
| --- | --- |
| 未安装桌面版 / 找不到 CLI | 适配器 `healthCheck` 报不可用；调度器派单时报「未注册/不可用」，任务失败 |
| CLI 升级后 JSONL 结构变化 | 解析器按 `record.type ?? part.type` 容错；无法识别的事件忽略并保留原始日志；仍失败则改走 HTTP `serve` + SSE |
| `--standalone` 行为变化 | 改走 HTTP：`serve --port 0` → `/session` + `/event`，映射层不变（仍是同一套 `RuntimeEvent`） |
| 免费模型不可用 | 通过 `OPENCOXSWAIN_DEFAULT_MODEL` 指定 `provider/model`；真实模型产生费用，只由用户显式配置触发 |

## 8. 复现命令

```powershell
$bin = "$env:APPDATA\ai.opencode.desktop\cli\2.2.6-x64\opencode-cli.exe"
& $bin --version

$root = Join-Path $env:TEMP "oc-spike"
New-Item -ItemType Directory -Force -Path "$root\data","$root\config","$root\cache","$root\state" | Out-Null
$env:XDG_DATA_HOME = "$root\data"
$env:XDG_CONFIG_HOME = "$root\config"
$env:XDG_CACHE_HOME = "$root\cache"
$env:XDG_STATE_HOME = "$root\state"

& $bin run --standalone --format json "在当前目录创建 hello.txt，内容为 hello"
```

仓库内的自动化验证：`pnpm e2e:opencode`（需要本机已安装 OpenCode；未安装时脚本会跳过并说明原因）。
