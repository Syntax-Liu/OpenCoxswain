/**
 * 运行时 CLI 入口：让自研运行时能独立跑起来，不需要任何外部软件。
 *
 * 用法：
 *   node dist/cli.js --project D:/work/app
 *   node dist/cli.js --project D:/work/app --say "把登录页重构一下"
 *
 * 环境变量（OpenAI 兼容）：
 *   OPENCOXSWAIN_LLM_API_KEY   （必需）
 *   OPENCOXSWAIN_LLM_BASE_URL  默认 https://api.deepseek.com/v1
 *   OPENCOXSWAIN_LLM_MODEL     默认 deepseek-chat
 *
 * 这个 CLI 是运行时的**最小可用面**：能开项目、能对 Assistant 说话、能看执行者进展。
 * 图形界面与 HTTP/SSE 在后续阶段接在同一个 Orchestrator 上。
 */
import { createInterface } from 'node:readline';

import { Orchestrator, startServer, type RuntimeEvent } from './index.js';
import { LlmProvider, LlmSettingsStore } from './llm/settings.js';
import { SqliteStore } from './store/sqlite.js';
import { MarkdownMemoryStore } from './memory/store.js';
import { ImSettingsStore } from './im/settings.js';
import { ImBridge } from './im/bridge.js';
import { TelegramClient } from './im/telegram.js';
import { loadExtensions } from './extensions/index.js';
import { ScheduleStore } from './schedules/store.js';
import { TokenStore } from './server/token.js';
import { secretServiceFromEnv } from './llm/secret.js';
import path from 'node:path';
import os from 'node:os';

interface CliArgs {
  readonly project: string;
  readonly say?: string;
  readonly name?: string;
  readonly maxConcurrent: number;
  /** 是否同时启动 HTTP/SSE 服务；`--serve` 开启，`--port` 指定端口。 */
  readonly serve: boolean;
  readonly port: number;
  /** 静态资源目录（工作台构建产物）；给了就同端口服务界面。 */
  readonly staticDir?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let project = '';
  let say: string | undefined;
  let name: string | undefined;
  let maxConcurrent = 5;
  let serve = false;
  // 端口优先级：--port 参数 > OPENCOXSWAIN_PORT 环境变量 > 默认 47900。
// 环境变量存在是为了"端口被别的程序占了"时能换一个，不用改启动参数。
let port = Number(process.env.OPENCOXSWAIN_PORT) || 47900;
  let staticDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--project':
      case '-p':
        project = next ?? '';
        i += 1;
        break;
      case '--say':
        say = next;
        i += 1;
        break;
      case '--name':
        name = next;
        i += 1;
        break;
      case '--max-concurrent':
        maxConcurrent = Number(next) || maxConcurrent;
        i += 1;
        break;
      case '--serve':
        serve = true;
        break;
      case '--port':
        port = Number(next) || port;
        i += 1;
        break;      case '--static':
        staticDir = next;
        // 给了静态目录意味着要服务界面，自动开启 HTTP。
        serve = true;
        i += 1;
        break;
      default:
        break;
    }
  }

  if (!project && !serve) {
    throw new Error(
      '缺少 --project。用法：node dist/cli.js --project D:/work/app [--say "任务"]\n' +
        '（--serve 模式下可以不给 --project：项目由界面里的"打开项目"决定）',
    );
  }
  return {
    project,
    maxConcurrent,
    serve,
    port,
    ...(staticDir ? { staticDir } : {}),
    ...(say ? { say } : {}),
    ...(name ? { name } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 密钥：环境变量优先，其次本地文件。**没有密钥也要起服务**，
  // 否则桌面应用双击后是一个空白窗口 —— 用户没有终端去设环境变量。
  // 界面通过 /api/settings 引导填写，保存后立刻生效。
  // 密钥加密：桌面壳会注入 DPAPI 服务地址与令牌。
  // 直接跑 CLI 时没有它，于是退回明文——由 storageMode 如实告诉用户。
  const secretCipher = secretServiceFromEnv();
  if (secretCipher) {
    console.log('密钥将以 DPAPI 密文存储');
  } else {
    console.warn('提示：未检测到桌面壳的加密服务，密钥将以明文存储');
  }

  const settingsStore = new LlmSettingsStore({
    file:
      process.env.OPENCOXSWAIN_LLM_FILE ??
      path.join(os.homedir(), '.opencoxswain', 'llm.json'),
    cipher: secretCipher,
  });
  const llm = new LlmProvider(settingsStore);
  const ready = await llm.refresh();

  if (!ready && !args.serve) {
    // 纯命令行模式没有界面可引导，直接给可读提示。
    console.error(
      '未配置模型密钥：请设置 OPENCOXSWAIN_LLM_API_KEY（或 DEEPSEEK_API_KEY），\n' +
        '或加 --serve 启动界面后在设置里填写。',
    );
    process.exitCode = 1;
    return;
  }
  if (!ready) {
    console.log('尚未配置模型密钥：界面打开后请在设置里填写（保存后立即生效）。');
  }

  // 持久化：默认放在用户数据目录，关掉软件后 Assistant 的上下文与项目都还在。
  const dbPath =
    process.env.OPENCOXSWAIN_DB ??
    path.join(os.homedir(), '.opencoxswain', 'runtime.db');
  const store = new SqliteStore({ file: dbPath });

  // 记忆：本地 Markdown，用户可直接打开编辑（对齐 TRAE 宝布局）。
  const memoryRoot =
    process.env.OPENCOXSWAIN_MEMORY ??
    path.join(os.homedir(), '.opencoxswain', 'memory');
  const memory = new MarkdownMemoryStore({ rootDir: memoryRoot });

  // 加载用户扩展（geek 自定义口）。目录不存在是常态，出错不影响启动。
  const extensions = await loadExtensions();
  if (extensions.names.length > 0) {
    console.log(`已加载 ${extensions.names.length} 个扩展：${extensions.names.join(', ')}`);
  }
  for (const problem of extensions.problems) {
    console.warn(`扩展加载失败（已跳过）：${problem}`);
  }

  const runtime = new Orchestrator({
    store,
    llm,
    maxConcurrentExecutors: args.maxConcurrent,
    memory,
    // 定时配置落成 JSON：量小，用户还能直接看和改。
    schedules: new ScheduleStore(path.join(os.homedir(), '.opencoxswain', 'schedules.json')),
    ...(extensions.beforeTool.length + extensions.afterTool.length > 0
      ? { extensions: { beforeTool: extensions.beforeTool, afterTool: extensions.afterTool } }
      : {}),
  });

  // 重启恢复：上次被中断的执行者如实标记为失败，不静默重跑。
  const recovery = await runtime.recover();
  if (recovery.interruptedExecutors.length > 0) {
    console.log(
      `发现 ${recovery.interruptedExecutors.length} 个上次被中断的执行者，已标记为失败：` +
        recovery.interruptedExecutors.map((e) => `${e.label}(${e.id})`).join('、'),
    );
  }

  runtime.on('runtime', (event: RuntimeEvent) => {
    switch (event.type) {
      case 'assistant_text':
        console.log(`\n[Assistant] ${event.text}\n`);
        break;
      case 'executor_started':
        console.log(`[执行者] ${event.executor.label} 开始（${event.executor.id}）`);
        break;
      case 'executor_queued':
        console.log(`[执行者] ${event.executor.label} 排队：${event.reason}`);
        break;
      case 'executor_settled':
        console.log(
          `[执行者] ${event.executor.label} ${event.ok ? '完成' : '未完成'}（${event.executor.id}）`,
        );
        break;
      case 'report':
        console.log(`[汇报${event.report.needsUser ? '·待决策' : ''}] ${event.report.body}`);
        break;
      case 'turn_judged':
        console.log(`[判定] ${event.judged} — ${event.reason}`);
        break;
    }
  });

  // 项目可选：服务模式下它由界面里的"打开项目"决定；
  // 命令行模式下必须有（否则没法对话）。
  const project = args.project
    ? await (async () => {
        const opened = await runtime.openProject({
          rootPath: args.project,
          ...(args.name ? { name: args.name } : {}),
        });
        console.log(`已打开项目「${opened.project.name}」：${opened.project.displayPath}`);
        console.log(`Assistant会话：${opened.project.assistantSessionId}\n`);
        return opened.project;
      })()
    : undefined;

  // IM 通道：配置了 token 才构造，没配就完全不占资源。
  const imSettings = new ImSettingsStore({
    file:
      process.env.OPENCOXSWAIN_IM_FILE ?? path.join(os.homedir(), '.opencoxswain', 'im.json'),
  });
  const imConfig = await imSettings.resolve();
  // 桥接内部通过闭包读最新配置，绑定 chat 后能立刻生效。
  let currentImConfig = imConfig;
  const im = imConfig.botToken
    ? new ImBridge({
        client: new TelegramClient(imConfig.botToken),
        orchestrator: runtime,
        store,
        config: () => currentImConfig,
        saveConfig: async (next) => {
          currentImConfig = next;
          await imSettings.save(next);
        },
        log: (level, message) => console.log(`[${level}] ${message}`),
      })
    : null;

  // 本机访问令牌：首次启动生成，之后复用。
  // 作用是把"同机任意程序/网页都能调 API"缩小到"知道令牌的程序"。
  const tokenStore = new TokenStore({
    file:
      process.env.OPENCOXSWAIN_TOKEN_FILE ??
      path.join(os.homedir(), '.opencoxswain', 'token'),
  });
  const apiToken = await tokenStore.resolve();

  // 可选的 HTTP/SSE 服务：桌面壳与 IM 通道都接在这里。
  const server = args.serve
    ? await startServer({
        orchestrator: runtime,
        store,
        port: args.port,
        token: apiToken,
        ...(args.staticDir ? { staticDir: args.staticDir } : {}),
        imSettings,
        im,
        llmSettings: {
          status: () => settingsStore.status(),
          save: (settings) => settingsStore.save(settings),
          clear: () => settingsStore.clear(),
          refresh: () => llm.refresh(),
        },
        log: (_level, message) => console.log(message),
      })
    : undefined;
  if (server) {
    console.log(`HTTP/SSE 已就绪：${server.url}`);
    if (args.staticDir) {
      console.log(`工作台界面：${server.url}/`);
    }
    console.log(`  GET  ${server.url}/api/health`);
    console.log(`  GET  ${server.url}/api/events   (SSE)`);
  }

  // IM 通道跑起来：有这个通道，Agent 的结论和待审批能推到手机。
  if (im) {
    im.start();
    console.log(
      imConfig.chatIds.length > 0
        ? `IM 通道已启动（${imConfig.chatIds.length} 个已绑定对话）`
        : 'IM 通道已启动，等待第一条消息完成绑定',
    );

    // 危险动作与汇报同步推手机（通过统一的事件流，不侵入业务层）。
    runtime.on('runtime', (event) => {
      if (event.type === 'approval_requested') {
        void im.notifyApproval(event.approvalId, event.category, event.evidence);
      } else if (event.type === 'report') {
        void im.notifyReport(event.report.body, event.report.needsUser);
      }
    });
  }

  if (args.say) {
    if (!project) {
      throw new Error('--say 需要配合 --project 使用');
    }
    await runtime.userSays(project.id, args.say);
    // 等待安静下来再退出（单次模式）。
    await waitQuiet(runtime, project.id, 3000);
    await server?.close();
    await runtime.dispose();
    return;
  }

  // 服务模式（无 --project）：不进入交互循环，进程常驻直到被结束。
  // 桌面壳就是这条路径：界面通过 HTTP/SSE 与它通信。
  if (!project) {
    console.log('服务模式：项目由界面里的"打开项目"决定。按 Ctrl+C 退出。');
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        void (async () => {
          await server?.close();
          await runtime.dispose();
          resolve();
        })();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
    return;
  }

  // 交互模式：用户可以连发，不会被阻塞。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('输入任务或问题，回车发送。输入 /quit 退出。');
  const ask = (): void => {
    rl.question('> ', async (line) => {
      const text = line.trim();
      if (text === '/quit') {
        await server?.close();
        await runtime.dispose();
        rl.close();
        return;
      }
      if (text) {
        await runtime.userSays(project.id, text);
      }
      ask();
    });
  };
  ask();
}

/** 等 Assistant 与所有 D 都空闲。 */
async function waitQuiet(runtime: Orchestrator, projectId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const assistant = runtime.getAssistant(projectId);
    const busy = assistant?.isRunning || runtime.stats().running > 0;
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
