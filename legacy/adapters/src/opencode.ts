import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  newId,
  now,
  type AcceptanceResult,
  type CostLedger,
  type TaskContract,
  type WorkerResult,
} from '@opencoxswain/shared';
import type {
  HealthStatus,
  InputDelivery,
  InputReceipt,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  SessionOptions,
} from './adapter.js';
import {
  collectArtifacts,
  commitChanges,
  headOf,
  judgeCriterion,
  killTree,
} from './tooling.js';
import { PidLedger, type ReapResult } from './pid-ledger.js';

interface OpenCodeRecord {
  type?: string;
  part?: {
    type?: string;
    text?: { text?: string };
    tool?: string;
    state?: {
      status?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
    };
    cost?: number;
    tokens?: { input?: number; output?: number };
  };
  error?: { message?: string; data?: { message?: string } };
}

interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

class OpenCodeSession implements RuntimeSession {
  readonly id = newId('ses');
  cancelled = false;
  paused = false;
  result: WorkerResult | null = null;
  baseHead: string | null = null;
  child: ChildProcess | null = null;

  constructor(
    readonly taskId: string,
    readonly worktree: string,
    readonly options: SessionOptions,
  ) {}
}

function parseLine(line: string): OpenCodeRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OpenCodeRecord;
  } catch {
    return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split('-')[0]!
      .split('.')
      .map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function desktopBinaries(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const root = path.join(appData, 'ai.opencode.desktop', 'cli');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+-[a-z0-9]+$/i.test(entry.name))
    .sort((left, right) => compareVersions(right.name, left.name))
    .map((entry) => path.join(root, entry.name, 'opencode-cli.exe'));
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function probe(command: string, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => void killTree(child), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface OpenCodeOptions {
  /** 显式二进制路径；优先于桌面版自动发现与 PATH。 */
  binPath?: string;
  /** 验收命令超时。 */
  commandTimeoutMs?: number;
  /** 单次 OpenCode 执行总超时。 */
  runTimeoutMs?: number;
  /** PID 台账目录；daemon 被强杀后按台账回收遗留进程。 */
  ledgerDir?: string;
  env?: Record<string, string>;
  /** 每次派发前解析的动态环境与 provider 配置，跟随用户后来保存的模型设置。 */
  setup?: () => Promise<OpenCodeSetup>;
}

export interface OpenCodeSetup {
  /** 追加到子进程环境变量，例如 DEEPSEEK_API_KEY。 */
  env?: Record<string, string>;
  /** 写入会话隔离的 opencode.json，用于声明自定义 provider 与模型。 */
  config?: Record<string, unknown>;
}

/**
 * OpenCode 运行时适配器。
 *
 * 桌面版 CLI：`opencode-cli run --standalone --format json <prompt>`。
 * 每个会话注入独立 XDG 目录，避免污染用户全局数据。
 */
export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'opencode';
  readonly version = '0.9.0';
  /**
   * CLI 进程不支持 stdin 注入：中途消息写入 worktree 的 inbox，标为 queued，
   * 由下一次派发的契约摘要携带，绝不假装 delivered。
   */
  readonly capabilities = { input: true, approvalGate: false, resume: false };
  /** 外部 CLI 进程无法在执行前挂起，危险动作由调度器在事件边界冻结。 */
  readonly supportsApprovalGate = false;

  private readonly sessions = new Map<string, OpenCodeSession>();
  private readonly binPath: string;
  private readonly commandTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly ledger: PidLedger | null;
  private readonly env: Record<string, string>;
  private readonly setup: (() => Promise<OpenCodeSetup>) | null;
  private resolved: string | null | undefined;

  constructor(options: OpenCodeOptions = {}) {
    this.binPath = options.binPath?.trim() ?? '';
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 15 * 60_000;
    this.ledger = options.ledgerDir ? new PidLedger(options.ledgerDir) : null;
    this.env = options.env ?? {};
    this.setup = options.setup ?? null;
  }

  async healthCheck(): Promise<HealthStatus> {
    const bin = await this.locate();
    if (!bin) {
      return {
        ok: false,
        detail:
          '未找到 OpenCode CLI：设置 OPENCOXSWAIN_OPENCODE_BIN，或安装 OpenCode Desktop（自带 opencode-cli.exe）',
      };
    }
    const result = await probe(bin, { ...process.env, ...this.env });
    return result.code === 0
      ? { ok: true, detail: result.stdout.trim() || `opencode ready (${bin})` }
      : {
          ok: false,
          detail: `${bin} --version 失败：${result.stderr.trim() || `exit ${result.code}`}`,
        };
  }

  async createSession(options: SessionOptions): Promise<RuntimeSession> {
    const info = await stat(options.worktree);
    if (!info.isDirectory()) {
      throw new Error(`worktree 不是目录：${options.worktree}`);
    }
    const session = new OpenCodeSession(options.taskId, options.worktree, options);
    session.baseHead = await headOf(options.worktree);
    this.sessions.set(session.id, session);
    return session;
  }

  async cancel(session: RuntimeSession): Promise<void> {
    session.cancelled = true;
    const target = this.sessions.get(session.id);
    await this.kill(target?.child ?? null);
  }

  async sendInput(
    session: RuntimeSession,
    input: InputDelivery,
  ): Promise<InputReceipt> {
    const target = this.requireSession(session);
    const dir = path.join(target.worktree, '.opencoxswain', 'inbox');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${input.id}.md`),
      `# 中途消息（${input.source}）\n\n${input.text}\n`,
      'utf8',
    );
    return 'queued';
  }

  async collect(session: RuntimeSession): Promise<WorkerResult> {
    const target = this.requireSession(session);
    if (!target.result) {
      throw new Error(`会话 ${session.id} 还没有结果`);
    }
    return target.result;
  }

  async dispose(session: RuntimeSession): Promise<void> {
    const target = this.sessions.get(session.id);
    await this.kill(target?.child ?? null);
    this.sessions.delete(session.id);
  }

  /** daemon 退出时回收所有仍存活的会话，避免 OpenCode 进程树变成孤儿。 */
  async disposeAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      session.cancelled = true;
      await this.kill(session.child);
      this.sessions.delete(session.id);
    }
  }

  /** daemon 上次被强制结束时，回收台账里仍存活的 OpenCode 进程树。 */
  async reapOrphans(): Promise<ReapResult> {
    return this.ledger ? this.ledger.reap() : { killed: [], stale: [] };
  }

  async *send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const artifactsDir = path.join(this.artifactsRoot(session), task.task_id);
    await mkdir(artifactsDir, { recursive: true });
    const logsRef = path.join(artifactsDir, 'opencode.jsonl');
    await writeFile(logsRef, '');

    const emit = async (event: RuntimeEvent): Promise<RuntimeEvent> => {
      await appendFile(logsRef, `${JSON.stringify(event)}\n`);
      return event;
    };

    yield await emit({ type: 'started', at: now() });

    const bin = await this.locate();
    if (!bin) {
      yield await emit({
        type: 'error',
        at: now(),
        message: '未找到 OpenCode CLI，无法执行任务',
        retryable: false,
      });
      return;
    }
    if (target.cancelled) return;

    const startedAt = Date.now();
    const setup = this.setup ? await this.setup() : {};
    const isolation = await this.prepareIsolation(artifactsDir, session.id, setup.config);
    const child = spawn(bin, this.buildArgs(session, task), {
      cwd: session.worktree,
      env: {
        ...process.env,
        ...this.env,
        ...setup.env,
        ...session.options.env,
        ...isolation,
        CI: '1',
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    target.child = child;
    if (this.ledger && child.pid) {
      const pid = child.pid;
      // 正常结束、超时、取消都会触发 close，退出后立即销账。
      child.on('close', () => {
        void this.ledger?.release(pid);
      });
      await this.ledger.track(pid, {
        image: path.basename(bin),
        taskId: task.task_id,
        worktree: session.worktree,
        startedAt: now(),
      });
    }

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.kill(child);
    }, this.runTimeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8000);
    });

    const exitCode = new Promise<number>((resolve) => {
      child.on('error', (error) => {
        stderr = `${stderr}${error.message}`.slice(-8000);
        resolve(-1);
      });
      child.on('close', (code) => resolve(code ?? -1));
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let usd = 0;
    let lastText = '';

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      for await (const line of lines) {
        if (target.cancelled) break;
        const record = parseLine(line);
        if (!record) continue;
        const type = record.type ?? record.part?.type;

        if (type === 'text') {
          const text = record.part?.text?.text;
          if (typeof text === 'string' && text.trim() !== '') {
            lastText = text;
            yield await emit({ type: 'message', at: now(), text });
          }
          continue;
        }

        if (type === 'tool_use') {
          const tool = String(record.part?.tool ?? 'tool');
          const state = record.part?.state ?? {};
          yield await emit({ type: 'tool_call', at: now(), tool, input: state.input ?? null });
          yield await emit({
            type: 'tool_result',
            at: now(),
            tool,
            output: state.status === 'error' ? { error: state.error ?? '工具执行失败' } : state.output ?? null,
          });
          continue;
        }

        if (type === 'step_finish') {
          const stepUsd = Number(record.part?.cost) || 0;
          const stepIn = Number(record.part?.tokens?.input) || 0;
          const stepOut = Number(record.part?.tokens?.output) || 0;
          usd += stepUsd;
          tokensIn += stepIn;
          tokensOut += stepOut;
          yield await emit({
            type: 'cost',
            at: now(),
            cost: { tokensIn: stepIn, tokensOut: stepOut, usd: round(stepUsd, 4), minutes: 0 },
          });
          continue;
        }

        if (type === 'error') {
          const message =
            record.error?.data?.message ??
            record.error?.message ??
            'OpenCode 报告错误（详见原始日志）';
          yield await emit({ type: 'error', at: now(), message, retryable: true });
        }
      }
    }

    const code = await exitCode;
    clearTimeout(timer);
    target.child = null;

    if (target.cancelled) return;
    if (timedOut) {
      yield await emit({
        type: 'error',
        at: now(),
        message: `OpenCode 执行超时（${Math.round(this.runTimeoutMs / 60_000)} 分钟）`,
        retryable: true,
      });
      return;
    }
    if (code !== 0) {
      const detail = stderr.trim() ? `：${stderr.trim()}` : '';
      yield await emit({
        type: 'error',
        at: now(),
        message: `OpenCode 退出码 ${code}${detail}`,
        retryable: true,
      });
      return;
    }

    if (!session.options.role.readOnly) {
      const committed = await commitChanges(session.worktree, `opencoxswain: ${task.title}`);
      if (committed) {
        yield await emit({ type: 'message', at: now(), text: '变更已提交到任务分支。' });
      }
    }

    const acceptance: AcceptanceResult[] = [];
    for (const [index, criterion] of task.acceptance_criteria.entries()) {
      const result = await judgeCriterion(criterion, {
        worktree: session.worktree,
        baseHead: target.baseHead,
        roleName: session.options.role.name,
        writeScope: task.write_scope ?? [],
        env: { ...process.env, ...session.options.env },
        timeoutMs: this.commandTimeoutMs,
      });
      acceptance.push(result);
      yield await emit({
        type: 'progress',
        at: now(),
        percent: Math.round(((index + 1) / task.acceptance_criteria.length) * 70) + 20,
        note: `${criterion.id} ${result.status}`,
      });
    }

    const artifacts = await collectArtifacts({
      worktree: session.worktree,
      baseHead: target.baseHead,
      task,
      roleName: session.options.role.name,
      acceptance,
      artifactsDir,
    });
    for (const artifact of artifacts) {
      yield await emit({ type: 'artifact', at: now(), artifact });
    }

    const cost: CostLedger = {
      tokensIn,
      tokensOut,
      usd: round(usd, 4),
      minutes: round((Date.now() - startedAt) / 60_000, 2),
    };
    const passed = acceptance.filter((item) => item.status === 'passed').length;
    const failed = acceptance.filter((item) => item.status === 'failed').length;
    const unverified = acceptance.filter((item) => item.status === 'unverified').length;
    const result: WorkerResult = {
      summary: `${session.options.role.name} 通过 OpenCode 完成：${artifacts.length} 个产物，验收 ${passed} 通过 / ${failed} 失败 / ${unverified} 待确认。${lastText ? `\n\n${lastText}` : ''}`,
      artifacts,
      acceptance,
      cost,
      logsRef,
    };
    target.result = result;
    yield await emit({ type: 'progress', at: now(), percent: 100, note: '完成' });
    yield await emit({ type: 'finished', at: now(), result });
  }

  private requireSession(session: RuntimeSession): OpenCodeSession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`未知会话：${session.id}`);
    return target;
  }

  private artifactsRoot(session: RuntimeSession): string {
    return (
      session.options.env.OPENCOXSWAIN_ARTIFACTS_DIR ??
      path.join(os.tmpdir(), 'opencoxswain-artifacts')
    );
  }

  private buildArgs(session: RuntimeSession, task: TaskContract): string[] {
    const args = ['run', '--standalone', '--format', 'json'];
    const model = session.options.model.model?.trim();
    if (model && !model.startsWith('mock-')) {
      args.push('--model', model);
    }
    if (session.options.role.readOnly) {
      args.push('--agent', 'plan');
    }
    args.push(this.promptFor(session, task));
    return args;
  }

  private promptFor(session: RuntimeSession, task: TaskContract): string {
    const scope = task.write_scope ?? [];
    const lines = [
      '你是一个独立执行任务的 AI 员工，当前目录就是你的 git worktree 根目录。',
      '',
      `任务：${task.title}`,
      `目标：${task.goal}`,
    ];

    if (session.options.role.readOnly) {
      lines.push('', '只读要求：不要修改、创建或删除任何文件，只做检查并向总管汇报结论。');
    } else {
      lines.push(
        '',
        `写入范围：${scope.length === 0 ? '仓库根目录内' : scope.join('、')}`,
        '请直接在当前目录完成修改，不要创建新的 worktree，也不要切换分支。',
      );
    }

    if (task.constraints && task.constraints.length > 0) {
      lines.push('', '约束：', ...task.constraints.map((item) => `- ${item}`));
    }

    if (task.acceptance_criteria.length > 0) {
      lines.push('', '验收项：');
      for (const criterion of task.acceptance_criteria) {
        lines.push(
          `- ${criterion.id}（${criterion.type}）：${criterion.desc}${criterion.check ? `，命令：${criterion.check}` : ''}`,
        );
      }
    }

    lines.push('', '完成后用简短中文汇报你改了什么、还有哪些风险。');
    return lines.join('\n');
  }

  private async prepareIsolation(
    artifactsDir: string,
    sessionId: string,
    config?: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const root = path.join(artifactsDir, 'opencode', sessionId);
    const env = {
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
    };
    for (const dir of Object.values(env)) {
      await mkdir(dir, { recursive: true });
    }
    if (config) {
      // OpenCode 在 Windows 上也认 XDG_CONFIG_HOME，写在这里不会污染用户全局配置与工作区。
      const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'opencode.json'),
        `${JSON.stringify(config, null, 2)}\n`,
        'utf8',
      );
    }
    return env;
  }

  private async locate(): Promise<string | null> {
    if (this.resolved !== undefined) return this.resolved;

    const candidates: string[] = [];
    if (this.binPath) candidates.push(this.binPath);
    candidates.push(...(await desktopBinaries()));

    for (const candidate of candidates) {
      if (await isFile(candidate)) {
        this.resolved = candidate;
        return candidate;
      }
    }

    if ((await probe('opencode', { ...process.env, ...this.env })).code === 0) {
      this.resolved = 'opencode';
      return 'opencode';
    }

    this.resolved = null;
    return null;
  }

  private async kill(child: ChildProcess | null): Promise<void> {
    await killTree(child, { group: true });
  }
}
