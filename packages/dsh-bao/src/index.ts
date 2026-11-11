/**
 * @opencoxswain/dsh-bao 插件入口（四层结构）。
 *
 * ```
 * A 用户 ──┬─→ B 全局助理（路由 + 转交原话）      global/tools.ts
 *          ├─→ C 项目助理（常驻根 Agent，项目的主人） assistant/
 *          └─→ D 执行 Agent（一事一 D，可追问）      executor/
 * ```
 *
 * 装配顺序：配置 → 宿主探测 → 打开 domain → 重建三个角色 → 恢复残留 → 注册工具。
 * 任何一步失败都尽量给出可读原因，而不是让插件静默加载后永远不干活。
 */
import { resolveConfig, type BaoConfig, type ResolvedConfig } from './config.js';
import { inspectHost, type HostApi } from './host.js';
import { AssistantManager } from './assistant/lifecycle.js';
import { buildAssistantTools } from './assistant/tools.js';
import { buildGlobalTools } from './global/tools.js';
import { buildProjectTools } from './project/tools.js';
import { ExecutorRunner } from './executor/runner.js';
import { Gate } from './executor/gate.js';
import { Reporter } from './executor/reporter.js';
import {
  createReport,
  listExecutors,
  listProjects,
  openBaoStore,
  recoverStaleExecutors,
  type BaoStore,
} from './store.js';

export type { BaoConfig, ResolvedConfig } from './config.js';
export { Gate, scopesConflict, normalizeWriteScopes } from './executor/gate.js';
export { ExecutorRunner, buildPrompt, classifyBlock } from './executor/runner.js';
export { Reporter } from './executor/reporter.js';
export { AssistantManager } from './assistant/lifecycle.js';
export { buildAssistantTools } from './assistant/tools.js';
export { buildGlobalTools } from './global/tools.js';
export { buildProjectTools } from './project/tools.js';
export { judge, crossCheck } from './assistant/judge.js';
export { deliver, stop } from './inbox/queue.js';
export {
  BAO_DOMAIN_NAME,
  BAO_DOMAIN_VERSION,
  EXECUTOR_STATUSES,
  TURN_JUDGMENTS,
  normalizeRootPath,
  type ExecutorRow,
  type ExecutorStatus,
  type ProjectRow,
  type ReportRow,
  type TurnJudgment,
  type TurnRow,
} from './domain.js';
export {
  createExecutor,
  createReport,
  createTurn,
  declareBaoDomain,
  ensureProject,
  finishExecutor,
  getExecutor,
  getProject,
  judgeTurn,
  listExecutors,
  listProjects,
  listReports,
  listTurns,
  openBaoStore,
  recoverStaleExecutors,
  type BaoStore,
} from './store.js';

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface BaoPluginOptions {
  readonly config?: BaoConfig;
  readonly host: HostApi;
  readonly log?: LogFn;
}

export interface BaoService {
  readonly gate: Gate;
  readonly runner: ExecutorRunner;
  readonly reporter: Reporter;
  readonly assistants: AssistantManager;
  readonly store: BaoStore;
  readonly config: ResolvedConfig;
  /** 当前宿主能力报告；`ok: false` 时插件仍加载，但派活会给出可读原因。 */
  readonly hostReport: ReturnType<typeof inspectHost>;
  /** 配置告警（如并发上限超过 dsh 配额）。 */
  readonly warnings: readonly string[];
  stats(): {
    running: number;
    queued: number;
    limit: number;
    executors: number;
    assistants: number;
  };
  dispose(): Promise<void>;
}

export async function createBaoService(options: BaoPluginOptions): Promise<BaoService> {
  const log: LogFn =
    options.log ??
    ((level, message) => {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
      sink(`[dsh-bao] ${message}`);
    });

  const hostReport = inspectHost(options.host);
  if (!hostReport.ok) {
    log('warn', `宿主能力不完整，部分功能将不可用：\n${hostReport.hint}`);
  }

  const hostLimit = readHostSubagentLimit(options.host);
  const { config, warnings } = resolveConfig(
    options.config,
    hostLimit === undefined ? {} : { hostMaxActiveSubagents: hostLimit },
  );
  for (const warning of warnings) {
    log('warn', `[${warning.code}] ${warning.message}`);
  }

  const store = await openHostStore(options.host, log);

  const gate = new Gate(config.maxConcurrentExecutors);

  const assistants = new AssistantManager({ store, config, host: options.host, log });

  const reporter = new Reporter({
    store,
    config,
    log,
    assistantOf: (projectId) => assistants.getAssistant(projectId),
  });

  const runner = new ExecutorRunner({
    store,
    gate,
    config,
    host: options.host,
    log,
    onSettled: (executor, result) => reporter.onSettled(executor, result),
  });

  // 重启恢复：上一世残留的 running/starting 一律转 failed 并写明原因。
  // D 的子代理随进程死了；C 由 assistantManager 在建项目时按需恢复（D5）。
  const recovered = await recoverStaleExecutors(store);
  if (recovered.length) {
    log(
      'info',
      `发现 ${recovered.length} 个上次未结束的执行者，已标记为失败：` +
        recovered.map((e) => `${e.label}(${e.id})`).join('、') +
        '。它们需要由对应的 C 重新派活。',
    );
  }

  // 工具注册。三类工具面向不同会话，但都在同一张工具表里；
  // 靠每个工具自己的"调用方校验"保证 A/B/C 各司其职。
  const disposers: Array<() => void> = [];
  const tools = options.host.tools;
  if (tools) {
    const assistantTools = buildAssistantTools({
      store,
      gate,
      runner,
      log,
      reportToUser: async (projectId, body, needsUser) => {
        await createReport(
          store,
          { projectId, kind: 'progress', body, needsUser },
          config.maxReportChars,
        );
      },
    });
    const globalTools = buildGlobalTools({
      store,
      log,
      assistantOf: (projectId) => assistants.getAssistant(projectId),
    });
    const projectTools = buildProjectTools({ store, assistants, log });

    for (const definition of [...projectTools, ...assistantTools, ...globalTools]) {
      disposers.push(tools.register(definition));
    }
    log(
      'info',
      `已注册 ${disposers.length} 个工具（项目 ${projectTools.length} / C ${assistantTools.length} / B ${globalTools.length}）`,
    );
  }

  let disposed = false;
  return {
    gate,
    runner,
    reporter,
    assistants,
    store,
    config,
    hostReport,
    warnings: warnings.map((w) => w.message),
    stats() {
      const s = gate.stats();
      return {
        ...s,
        executors: listExecutors(store).length,
        assistants: assistants.ownedCount,
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      // 顺序要紧：先冲刷最后一批汇报（C 还在场），再收 C，最后收 D。
      try {
        await reporter.flushAll();
      } catch {
        // 关停路径上的汇报失败不应阻断清理。
      }
      reporter.dispose();
      for (const dispose of disposers) dispose();
      await runner.disposeAll();
      await assistants.disposeAll();
      await store.close();
    },
  };
}

/**
 * 读宿主侧子代理并发上限，用它在配置超限时给出可读告警（方案 §7.2 / L5）。
 *
 * dsh 的 `SubagentRuntime` 把 `maxActiveSubagents` 放在 Cordis 的 `config`
 * 字段里（默认 8，见 dsh-subagent `Config.maxActiveSubagents`），没有公开
 * 读取方法。这里直接读那个字段；读不到就返回 undefined，由 config.ts
 * 回退到 dsh 默认值 8 —— 宁可给一条可能多余告警，也不要让用户在第 9 个
 * 执行者上撞一次 `ACTIVATION_LIMIT_REACHED` 硬失败。
 */
function readHostSubagentLimit(host: HostApi): number | undefined {
  const subagents = host.subagents as
    | { config?: { maxActiveSubagents?: unknown } }
    | undefined;
  const raw = subagents?.config?.maxActiveSubagents;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  return undefined;
}

async function openHostStore(host: HostApi, log: LogFn): Promise<BaoStore> {
  if (!host.storageDomain) {
    throw new Error(
      '宿主未提供 ctx.storageDomain，项目与执行者状态无法持久化，插件拒绝以"内存模式"假装工作。' +
        '请先在 dsh 中启用 @deepseek-ai/dsh-storage-domain 并配置存储后端。',
    );
  }
  const store = await openBaoStore(host.storageDomain);
  log('info', `任务库已打开（domain: bao v2，${listProjects(store).length} 个项目）`);
  return store;
}
