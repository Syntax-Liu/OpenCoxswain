# 006 部署

> 本文是 [006 Deployment](006-deployment.md) 的中文译文，供阅读参考；如有出入，以英文原文为准。

使用本指南安装、配置和运维 dsh-superagent。它涵盖账号、启动检查、升级和故障排查，建立在 [001 领域模型](001-domain.md) 到 [005 面板](005-panel.md) 之上。

## 运行的内容

- **一个专门的 DeepSeek Harness profile**，本指南中称为 `superagent`。从 Web profile 模板创建它。它加载本 bundle 并在 `127.0.0.1` 上提供其面板。请把它与你日常工作的 profile 分开：插件会修改进程级的 `PATH` 和 git 设置，而且它的进程需要独立的重启和升级。
- **一个 agent GitHub 账号。** agent 以该账号发表评论、推送分支和开启 PR，并且只通过仅以该账号登录的 GitHub CLI 进行。
- **可选：**一个用于聊天请求的 Feishu 机器人。

插件配置保存状态目录和机器限制。其他一切都在面板中完成：在“来源”中配置仓库和账号，在“策略”中配置允许名单，在“执行”中配置 worker 目录和命令。

### 权限与隔离

该 bundle 为执行器定义了 `dsh-superagent-worker`，为主 Session 定义了 `dsh-superagent-router`。它们出现在 DeepSeek Harness 的预设列表中，但仅供 dsh-superagent 使用。不要为个人 Session 选择它们，也不要禁用它们的配置行。应用需要它们来创建和恢复其 Session。

在 Web UI 中打开一个空的受管 Session 时，可能会选中该 profile 的默认预设。dsh-superagent 会在第一轮之前恢复其角色专属的预设。

两个预设都以 `danger-full-access`、以操作者的操作系统用户身份运行，并读取来自已订阅线程的消息。账号包装脚本默认选择 agent 的凭据；它们并不隔离进程。worker 可以按路径执行程序并读取操作者的家目录。要获得隔离，请使用一个只包含 agent 凭据的专用操作系统账号。

## 前置条件

- Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+ 和 tmux
- GitHub CLI（`gh`）2.48 或更高版本。来源的 CLI 字段必须指向 `gh` 或 `lark-cli` 包装脚本；宿主依赖它们的子命令和输出格式。
- github.com 上的一个仓库；不支持 GitHub Enterprise Server。要为每个工单创建检出，请保留一个本地克隆，prepare 命令可以从中添加 worktree。如果该仓库使用 Git LFS，请安装 `git-lfs`。
- 为 DeepSeek Harness 配置好模型提供方。除非评估或执行设置指定了其他模型，dsh-superagent 使用该 profile 的默认模型。
- 使用 Feishu 时：`lark-cli`（已测试 1.0.90）以及一个带机器人的 Feishu 或 Lark 应用

## 账号

### agent 的 GitHub 账号

1. 为 agent 创建一个 GitHub 用户账号，并授予它对仓库的写权限。GitHub App 不能充当 agent，因为 dsh-superagent 需要读取该账号的通知。
2. 给它一个只使用其自身凭据的 GitHub CLI：

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   以 agent 账号登录；最后一条命令会打印其登录名。dsh-superagent 以同样的方式读取登录名。

### Feishu 机器人（可选）

1. 创建一个带机器人能力的自建应用。授予它接收消息事件、读写群消息、读取群成员的权限，然后发布应用版本。
2. 给机器人一份自己的 `lark-cli` 配置，限制为机器人身份，并创建一个包装脚本：

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   第一条命令从标准输入读取 app secret。请使用单独的配置目录：`lark-cli` 每个 app id 只允许一个 profile，而你的个人配置中可能已经包含该应用的用户登录。

   宿主会拒绝能够以用户身份行动的 CLI。它从机器人配置中读取 app id、Feishu/Lark 品牌和机器人 `open_id`。

   两种配置共享 app secret 的钥匙串条目。若只想移除机器人配置，请删除其目录；不要运行 `lark-cli config remove`，那会影响共享的 secret。

## 安装

在一个尚无 `superagent` profile 的机器上运行以下代码块一次：

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

上面锁定的版本是公开版本；其他版本必须满足 `package.json` 中的 `engines.dsh`。

第四条命令从 DeepSeek Harness Web 模板创建 `~/.dsh/profiles/superagent`。第五条安装本 bundle。设置 `DSH_HOME` 可以改变默认的 `~/.dsh` 目录。

只在全新安装时运行创建 profile 的命令。如果 profile 已存在，该命令会替换它并删除其 `cordis.patch.yml`，包括机器配置。升级时不要使用它。

## 机器配置

把 [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) 复制为 `~/.dsh/profiles/superagent/cordis.patch.yml`（替换该文件），并替换每个 `<placeholder>`。使用 Feishu 时，还要在那里启用 `dsh-superagent-feishu` 条目。`webserver` 条目设置面板的端口。

| 键 | 必需 | 含义 |
| --- | --- | --- |
| `stateDir` | 是 | 绝对路径：数据库、锁、`worker-bin` 中的命令 shim、agent 的 git 配置，以及默认情况下 `work` 中的工单目录。升级前请备份它 |
| `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs` | 否 | 已保存提示词配置的最大尺寸，以及一次研判在多长时间内读取多少个线程页面 |

首次启动后，可在 **设置 → 部署** 或 DeepSeek Harness 插件管理器中编辑机器限制。更改无需重启即可生效。`stateDir` 无法在那里更改。无效的值或未知的配置键会阻止启动；日志会指出是哪个键。

## 启动与停止

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` 在 tmux 会话 `dsh-superagent`（其他 profile 则为 `dsh-<profile>`）中运行 `dsh --profile superagent`。它最多等待一分钟，直到运行时就绪或报告一项设置要求。首次运行时它会打印缺少的设置信息。它会拒绝重复实例，包括在本脚本之外启动的实例。

`stop` 和 `restart` 请求优雅关闭，并最多等待执行器五分钟。它们从不强制终止进程，也不碰其他 tmux 会话。

`status` 打印进程 id、健康状况和设置问题。要使用其他 profile 或端口，请用 `--profile` 和 `--url`，或设置 `DSH_SUPERAGENT_PROFILE` 和 `DSH_SUPERAGENT_URL`。

`status`、`start` 和 `restart` 以四种退出码之一退出：

| 退出码 | 含义 |
| --- | --- |
| 0 | 服务正常运行 |
| 1 | 它没有运行、运行了两份、不响应，或其运行时报告错误；重启可能修好 |
| 2 | 它在运行，但运行时之外的部分（例如某个来源或某次策略同步 `sync:<来源 id>`）报告错误；重启无法修好 |
| 3 | 它在运行并等待设置；重启无法修好 |

仍在启动中的来源算作正常运行。设置无法检查的 Feishu 机器人也是如此。

`status` 在 `errors` 下返回失败的部分及其细节，在 `setup` 下返回设置要求。`start` 和 `restart` 以行的形式打印这些问题；如果服务始终未能起来，它们以退出码 1 结束。只有主动执行的 `stop` 会暂停自动恢复。

每个 profile 都在 `.artifacts/` 下保存日志和控制文件：

- 启动日志：`dsh-superagent-<profile>-<date>-<time>-<pid>.log`，其中 pid 属于该脚本。保留最新的 20 份。
- 控制文件：`control/profiles/<profile>/`，包含停止标记、锁和进程 id。

打开日志中打印的 URL，然后在侧边栏中选择 **Superagent**。

### 每小时检查

在你日常使用的 DeepSeek Harness profile 中创建这个每小时检查，而不是在 `superagent` 中。它必须在 agent 服务停止时也能继续运行。请在该 profile 中让 agent 使用下面这段提示词创建每小时计划，并填入检出路径：

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` 会保留主动的停止。只有 `stop` 会写入该标记；`start` 会清除它。`restart` 不写标记，因此该检查可以恢复一次关闭超时的重启。

## 设置

在轮询或工作开始之前，设置必须成功。总览会列出缺少的要求并链接到相应设置。更改设置会重新运行设置。如果你在应用之外修好了某些东西（例如 CLI 认证），请选择 **重新检查**。

1. **来源。** 设置 GitHub 仓库（`owner/name`）和 agent CLI，例如 `/home/me/.local/bin/gh-agent`。请求通常通过 agent 账号的通知抵达。提到该账号的新 Issue 或评论会在下一次轮询时到达；通过编辑已有 Issue 正文添加的提及则不会。请改为发表新评论。对 Feishu，设置机器人 CLI、群、每个群的接收全部或仅 @ 模式，以及是否接收私信。
2. **策略。** 两条示例规则可以编辑或删除。在 **每个来源** 下，添加可以请求工作的 GitHub 账号和 Feishu 用户；名单上有人之前，任何请求都无法成为工单。对 Feishu，可以选择一个群用于同步名单，在启动时以及 **立即同步** 时执行。
3. **执行。** 目录根和 prepare 命令。要让每个工单都有一份仓库检出：

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   把个人 CLI（例如以你自己账号登录的那个）列为被禁止的命令。
4. **提示词。** 设置团队部分：GitHub 声明行、评审机器人、提交作者和自动合并条件。

### 管理 API

面板使用一个本地 HTTP API，agent 也可以调用它。`SETUP.md` 用它保存设置，服务脚本读取 `GET state`。

向 `http://127.0.0.1:<port>/orchestrator/api/` 发送请求，并带上 `x-orchestrator-request: 1`。宿主必须是 `127.0.0.1:<port>` 或 `localhost:<port>`。缺少请求头，或 `Origin` 来自其他站点，会收到 403。

API 保存具有面板的权限。与通过主 Session 工具所做的保存不同，它们可以更改执行环境和设置中的账号字段。

Agent 可以依赖这些路由和字段。`src/app/api.ts` 中的其他路由服务于面板，并随面板变化。

| 请求 | 应答 |
| --- | --- |
| `GET state` | 每个页面读取的内容：`setup`，含 `problem` 和 `feishuProblem`（各自为 `null` 或一个设置问题，带 `place`、`code`、`values` 和 `detail`），以及设置解析后的 `accounts`；`health`，每个部分一个条目（见下文），带 `state`（`starting`、`ready`、`paused` 或 `error`）、`detail` 和 `at`；`load`，即执行器 Session 的 `running`、工单的 `queued` 和 `maxWorkers`；`paused`；以及 `masterId` |
| `GET settings` | `blocks`：`policy`、`eval` 和 `executor`，各自带 `value` 和 `revision`；`sources`：来源实例，每个带 `id`、`kind`、`installed`、其区块的 `value`（`{"enabled": …, "config": {…}}`）和 `revision`、其类型的表单，以及有设置问题时的 `problem`；`policyVersion`；以及 `environment`，即执行环境的 `root` 和 `variables` |
| `GET sources` | 每个来源的状态：`state`（`missing`、`off`、`error`、`setup`、`starting`、`paused` 或 `ready`）、其各部分的 `health`、其设置 `problem`、最近一天的 `stats`、该天内它 `filtered` 的触发，以及该天内它 `dropped` 的消息（最新丢弃在前，每条带 `channel`、`preview`、属于某个工单时的 `ticket`（`id` 和 `title`）、存储中有其线程时的 `thread`，以及 `dropped.at`、`dropped.reason`、`channelGone` 或 `channelIgnored`） |
| `PUT settings/<block>`，body `{"value": …, "revision": n}` | 保存一个区块：`saved`、该区块的新 `revision`、`policy_changed` 和 `restarting`。`value` 是整个区块，形如 `GET settings` 中的形式；缺失的键取其默认值 |
| `POST executor/pause`，body `{"paused": true}` 或 `false` | 暂停或恢复处理：`paused` |
| `POST setup/check` | 通过重启 dsh-superagent 重新运行设置：`restarting: true`。当设置无事可修时被拒绝 |
| `POST policy-sync/<来源 id>` | 立即同步该来源的允许名单：`policy`，即该来源保存的部分 |
| `GET prompts`、`PUT prompts`（body `{"config", "baseRevision"}`） | 读取提示词配置：`current`（含其 `revision` 和 `config`）、`defaults`、`sections`（按 Session 读取顺序排列的团队部分）、`skillName`（团队技能名称的模式）、`builtin`（团队技能不可使用的名称），以及 `skillPrefix`（Session 加载技能名称时使用的前缀）。或保存它：返回新的 `revision` |
| `POST tickets/<id>/retry`、`POST tickets/<id>/stop` | 像面板那样重试或停止一个工单 |

健康条目按职责分组：

| 条目 | 报告内容 |
| --- | --- |
| `runtime` | 应用本身 |
| `models` | 等待模型预算重试的 Session |
| `evals` | 过去一小时内、之后没有新判断或忽略的未完成评估 |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | [003 执行](003-execution.md) 中描述的已存储工作；`delivery` 统计等待中的工作，`reply` 覆盖渠道消息 |
| `worker` | 执行器 Session 事件处理；在首次失败后出现 |
| `github`、`feishu`、`history` | 来源轮询、事件和历史恢复 |
| `sync:<来源 id>` | 允许名单同步 |

一次拒绝会带有状态码和 `error`（其英文文本）：

- 400：无效的值（`issues`，各带 `path`）、账号检查失败（`setup`）、固定的拒绝（`code` 和 `values`），或不是 JSON 或过大的请求体。
- 404：不存在的东西。
- 409：过期的修订号。
- 500：其他情况。

区块：

- `source:github`、`source:feishu`：`{"enabled": true, "config": {…}}`。GitHub 的配置有 `repository` 和 `cli`，以及默认关闭的开关 `observeIssues`、`observePulls`、`observeComments` 和 `observeCi`，它们会接收仓库中每个新 Issue、新 PR 和新评论以及默认分支的 CI；Feishu 的配置有 `cli`、`chats`（形如 `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]`，或 `"all"`）、`directMessages`，以及取值为 `"none"` 或 `"mentions"` 的 `otherChats`。
- `policy`：`{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`。`bots` 列出其消息可以成为推断候选的机器人。`admission` 行在 Feishu 上以群 id、`other` 或 `direct` 为键，在 GitHub 上以 `issues`、`pulls`、`comments` 或 `ci` 为键；未设置的格取其默认值（参见 [002 授权](002-authorization.md)）。
- `eval`：`mode`、`timeoutSeconds` 和 `model`。
- `executor`：`model`、`maxWorkers`、`directory`、`prepare` 和 `blockedCommands`。处理暂停是一个独立设置 `paused`，由 `POST executor/pause` 设置。

更改仓库或 CLI 会先运行相应的设置检查。检查失败会返回 400，细节在 `setup` 中。账号更改成功，或在设置待定时进行任何保存，都会返回 `restarting: true`。应用重启期间 API 暂时不可用。

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## 设置检查

设置使用 DeepSeek Harness 的子进程服务，与 worker shell 相同。它会移除名称中包含 KEY、PASSWORD、SECRET 或 TOKEN 的环境变量。

设置会验证 GitHub 仓库和 agent 的推送权限、写入 worker 环境，并检查 git 对 github.com 只使用 agent 凭据。Feishu 设置失败只会禁用 Feishu 来源。

设置会写入的进程环境：

- **命令 shim**，位于 `<stateDir>/worker-bin`，在 `PATH` 最前面：`gh` 运行 agent 的 CLI；`lark-cli` 运行机器人的 CLI；被禁止的命令会失败。shim 在运行其目标之前会从 `PATH` 中移除自己所在的目录。
- **git 配置**，位于 `<stateDir>/worker-gitconfig`：取代操作者的全局和系统 git 配置。它选择 agent CLI 作为 github.com 的凭据助手，把 GitHub SSH 地址改写为 HTTPS，并定义 Git LFS 过滤器。HTTP 代理之类的个人 git 设置不会生效。这里不设置提交身份，git 从不提示输入凭据，并且会移除 `GH_TOKEN` 和 `GITHUB_TOKEN`。

`worker-bin` 或 `worker-gitconfig` 中不是由 dsh-superagent 写入的文件会阻止设置。工单目录位于某个自身配置添加了凭据的 git 仓库中时，会使该工单失败。

## 试一试

用一个允许名单上的 GitHub 账号，开启一个 Issue 或发表一条包含 `@<agent 登录名> <请求>` 的评论。在一个轮询间隔内（默认一分钟），总览应当出现一个工单。agent 会确认请求，在它自己的 Session 和目录中工作，并在原始会话中交付。对 Feishu，请在已配置的群中 @ 该机器人。

## 升级

1. 等到没有执行器正处于一轮之中。
2. 备份 `<stateDir>/orchestrator.sqlite`。
3. 运行 `git pull && pnpm install && pnpm build`。
4. 运行 `scripts/dsh-superagent restart` 并检查其状态。

重启会结束正在运行的派工，并以恢复说明启动替代派工。团队文本和被覆盖的提示词部分会保留；没有覆盖的部分跟随新的默认内容。升级后请检查标为 **Default updated** 的部分。

被更新版本迁移过的数据库无法被旧版本打开。因此回滚需要升级前的备份。在升级 DeepSeek Harness 本身之后，请重启正在运行的实例，以便面板加载相匹配的产物。

### Agent 预设

worker 和 router 预设会在 5 秒后把 shell 命令移到后台。Session 没有其预设就无法加载。在其 Session 使用期间，请保留 `cordis.patch.yml` 中的 `dsh-superagent-worker` 和 `dsh-superagent-router` 行；否则恢复会以 `agent-preset/not-found` 失败。

## 故障排查

设置问题会以面板语言显示在总览上，并链接到修复位置；日志和 API 显示下面的英文文本。

| 症状 | 原因与修复 |
| --- | --- |
| `The agent GitHub CLI is not set.` | 在 GitHub 卡片上设置 agent 的 CLI |
| `The agent GitHub CLI was not found.` | 设置包装脚本的绝对路径，或 `PATH` 上的命令名 |
| `The agent GitHub CLI cannot read its account` | 用 `auth login` 登录该包装脚本 |
| `@… cannot read …` 或 `@… cannot push to …` | 授予 agent 账号对仓库的写权限 |
| `The GitHub Source names no repository.` | 在 GitHub 卡片上设置仓库 `owner/name` |
| 工单失败并提示 `The prepare command failed: …` | 输出会指出原因，例如错误的克隆路径；修正命令后重试该工单 |
| `git does not read the github.com credential configuration dsh-superagent writes` | 安装 git 2.32 或更高版本 |
| 工单失败并提示 `The git configuration of the repository in … sets …` | 从该克隆的 `.git/config` 中删除所指的凭据或 `http.*.extraheader` 设置 |
| `… was not written by dsh-superagent` | 把所指文件移出 `<stateDir>/worker-bin` 或 `<stateDir>/worker-gitconfig`，或改用另一个 `stateDir` |
| `The bot lark-cli allows user identities` | 把 Feishu 来源指向仅限机器人的配置，如上面的 Feishu 机器人一节 |
| `The bot lark-cli does not work.` 或 `The bot identity of app … is …` | 检查配置中的 app id 和 secret |
| `The Feishu bot is not a member of the chat.` | 在该群的设置中把机器人加入群；下一次尝试即可成功 |
| `status` 退出码为 2 | 某个部分报告错误，重启无法修复：`errors` 会列出每个部分（如管理 API 一节所列）及其细节；各部分在恢复正常后自行清除其条目 |
| `status` 退出码为 3 | 设置仍在等待：`setup` 说明缺少什么，总览链接到可修复它的设置 |
| `status` 退出码为 1 | 服务没有运行、运行了两份、不响应，或其运行时报告错误；输出和最新日志会说明是哪一种 |
| `… timed out after 90 s`、`… was stopped by …`、`… exited with code …` 或 `… could not run: …` | CLI 失败但没有打印原因；以操作者用户身份手动运行所指程序，查看它自己的消息 |
| 面板提示 dsh-superagent 无响应 | 它正在重启，或因配置而未能启动；DeepSeek Harness 日志会指出原因 |
| `dsh-superagent configuration has keys it does not use`（日志） | 删除所指的键；消息会说明每个值现在位于何处 |
| 日志显示插件与正在运行的 dsh 不兼容 | 安装一个处于 `engines.dsh` 范围内的 DeepSeek Harness 版本 |
| 升级 DeepSeek Harness 后面板显示 "Failed to load plugins" | 重启正在运行的实例 |
| @ 之后什么也没发生 | 检查作者是否在来源的允许名单上、来源是否开启、处理是否未暂停。在 GitHub 上，通过编辑 Issue 正文添加的提及不会被接收；请在评论中 @ agent |
