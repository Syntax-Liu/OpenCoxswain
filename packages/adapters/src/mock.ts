import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  newId,
  now,
  type AcceptanceCriterion,
  type AcceptanceResult,
  type ArtifactRef,
  type CostLedger,
  type TaskContract,
  type WorkerResult,
} from '@opencoxswain/shared';
import type {
  HealthStatus,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  SessionOptions,
} from './adapter.js';

interface MockInput {
  files?: Array<{ path: string; content: string }>;
  command?: string;
  fail?: boolean;
  cost?: Partial<CostLedger>;
  sleepMs?: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

class MockSession implements RuntimeSession {
  readonly id = newId('ses');
  cancelled = false;
  paused = false;
  result: WorkerResult | null = null;
  baseHead: string | null = null;

  constructor(
    readonly taskId: string,
    readonly worktree: string,
    readonly options: SessionOptions,
  ) {}
}

const DEFAULT_COST: CostLedger = { tokensIn: 6000, tokensOut: 1200, usd: 0.02, minutes: 0.05 };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string, length = 800): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
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

function git(cwd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = path.resolve(target).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

/** 离线可跑的运行时替身：真实 worktree 写文件、跑命令、产出 diff。 */
export class MockRuntimeAdapter implements RuntimeAdapter {
  readonly name = 'mock';
  readonly version = '0.1.0';

  private readonly sessions = new Map<string, MockSession>();
  private readonly commandTimeoutMs: number;

  constructor(options: { commandTimeoutMs?: number } = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<HealthStatus> {
    return { ok: true, detail: 'mock adapter ready' };
  }

  async createSession(options: SessionOptions): Promise<RuntimeSession> {
    const info = await stat(options.worktree);
    if (!info.isDirectory()) {
      throw new Error(`worktree 不是目录：${options.worktree}`);
    }
    const session = new MockSession(options.taskId, options.worktree, options);
    const head = await git(options.worktree, ['rev-parse', 'HEAD']);
    session.baseHead = head.code === 0 ? head.stdout.trim() : null;
    this.sessions.set(session.id, session);
    return session;
  }

  async cancel(session: RuntimeSession): Promise<void> {
    session.cancelled = true;
  }

  async pause(session: RuntimeSession): Promise<void> {
    session.paused = true;
  }

  async resume(session: RuntimeSession): Promise<void> {
    session.paused = false;
  }

  async collect(session: RuntimeSession): Promise<WorkerResult> {
    const target = this.requireSession(session);
    if (!target.result) {
      throw new Error(`会话 ${session.id} 还没有结果`);
    }
    return target.result;
  }

  async dispose(session: RuntimeSession): Promise<void> {
    this.sessions.delete(session.id);
  }

  async *send(session: RuntimeSession, task: TaskContract): AsyncIterable<RuntimeEvent> {
    const target = this.requireSession(session);
    const artifactsDir = this.artifactsDir(session, task);
    await mkdir(artifactsDir, { recursive: true });
    const logsRef = path.join(artifactsDir, 'worker.log');
    await writeFile(logsRef, '');

    const log = async (event: RuntimeEvent): Promise<void> => {
      await appendFile(logsRef, `${JSON.stringify(event)}\n`);
    };
    const emit = async (event: RuntimeEvent): Promise<RuntimeEvent> => {
      await log(event);
      return event;
    };

    yield await emit({ type: 'started', at: now() });
    const input = this.mockInput(task);

    if (input?.sleepMs) {
      await delay(input.sleepMs);
    }

    await this.waitWhilePaused(session);
    if (session.cancelled) return;

    if (input?.fail) {
      yield await emit({
        type: 'error',
        at: now(),
        message: 'mock 指定失败',
        retryable: true,
      });
      return;
    }

    if (session.options.role.readOnly) {
      yield await emit({
        type: 'message',
        at: now(),
        text: `${session.options.role.name} 以只读方式运行，不修改 worktree。`,
      });
    } else {
      for (const file of input?.files ?? []) {
        await this.waitWhilePaused(session);
        if (session.cancelled) return;
        const targetPath = path.resolve(session.worktree, file.path);
        if (!isWithin(session.worktree, targetPath)) {
          yield await emit({
            type: 'error',
            at: now(),
            message: `拒绝写入 worktree 之外的路径：${file.path}`,
            retryable: false,
          });
          return;
        }
        yield await emit({ type: 'tool_call', at: now(), tool: 'file_write', input: { path: file.path } });
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.content, 'utf8');
        yield await emit({ type: 'tool_result', at: now(), tool: 'file_write', output: { ok: true } });
      }
      const committed = await this.commit(target, task);
      if (committed) {
        yield await emit({ type: 'message', at: now(), text: '变更已提交到任务分支。' });
      }
    }

    const acceptance: AcceptanceResult[] = [];
    for (const [index, criterion] of task.acceptance_criteria.entries()) {
      await this.waitWhilePaused(session);
      if (session.cancelled) return;
      const result = await this.judge(criterion, target, task);
      acceptance.push(result);
      yield await emit({
        type: 'progress',
        at: now(),
        percent: Math.round(((index + 1) / task.acceptance_criteria.length) * 70) + 20,
        note: `${criterion.id} ${result.status}`,
      });
    }

    const artifacts = await this.collectArtifacts(target, task, acceptance, artifactsDir);
    for (const artifact of artifacts) {
      yield await emit({ type: 'artifact', at: now(), artifact });
    }

    const cost = this.costFor(input);
    const passed = acceptance.filter((item) => item.status === 'passed').length;
    const failed = acceptance.filter((item) => item.status === 'failed').length;
    const unverified = acceptance.filter((item) => item.status === 'unverified').length;
    const result: WorkerResult = {
      summary: `${session.options.role.name} 完成：${artifacts.length} 个产物，验收 ${passed} 通过 / ${failed} 失败 / ${unverified} 待确认。`,
      artifacts,
      acceptance,
      cost,
      logsRef,
    };
    target.result = result;
    yield await emit({ type: 'progress', at: now(), percent: 100, note: '完成' });
    yield await emit({ type: 'finished', at: now(), result });
  }

  private requireSession(session: RuntimeSession): MockSession {
    const target = this.sessions.get(session.id);
    if (!target) throw new Error(`未知会话：${session.id}`);
    return target;
  }

  private artifactsDir(session: RuntimeSession, task: TaskContract): string {
    const root =
      session.options.env.OPENCOXSWAIN_ARTIFACTS_DIR ??
      path.join(os.tmpdir(), 'opencoxswain-artifacts');
    return path.join(root, task.task_id);
  }

  private mockInput(task: TaskContract): MockInput | null {
    const value = task.inputs?.mock;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as MockInput;
  }

  private costFor(input: MockInput | null): CostLedger {
    return { ...DEFAULT_COST, ...input?.cost };
  }

  private async waitWhilePaused(session: RuntimeSession): Promise<void> {
    while (session.paused && !session.cancelled) {
      await delay(100);
    }
  }

  private async commit(session: MockSession, task: TaskContract): Promise<boolean> {
    const status = await git(session.worktree, ['status', '--porcelain']);
    if (status.code !== 0 || status.stdout.trim() === '') return false;
    await git(session.worktree, ['add', '-A']);
    const commit = await git(session.worktree, [
      '-c',
      'user.name=OpenCoxswain',
      '-c',
      'user.email=coxswain@localhost',
      'commit',
      '-m',
      `opencoxswain: ${task.title}`,
    ]);
    return commit.code === 0;
  }

  private async judge(
    criterion: AcceptanceCriterion,
    session: MockSession,
    task: TaskContract,
  ): Promise<AcceptanceResult> {
    if (criterion.type === 'command') {
      if (!criterion.check) {
        return { criterionId: criterion.id, status: 'unverified', judgedBy: 'system' };
      }
      const env = { ...process.env, ...session.options.env };
      const result = await runCommand(criterion.check, session.worktree, env, this.commandTimeoutMs);
      return {
        criterionId: criterion.id,
        status: result.code === 0 ? 'passed' : 'failed',
        evidence: `exit ${result.code}: ${truncate(`${result.stdout}${result.stderr}`.trim())}`,
        judgedBy: 'system',
      };
    }

    if (criterion.type === 'diff') {
      const changed = await this.changedFiles(session);
      if (changed.length === 0) {
        return {
          criterionId: criterion.id,
          status: 'failed',
          evidence: '没有产生变更',
          judgedBy: 'system',
        };
      }
      const scope = task.write_scope ?? [];
      const outside = scope.length === 0
        ? []
        : changed.filter((file) => !scope.some((prefix) => this.matchesScope(file, prefix)));
      return {
        criterionId: criterion.id,
        status: outside.length === 0 ? 'passed' : 'failed',
        evidence:
          outside.length === 0
            ? `变更文件：${changed.join(', ')}`
            : `越界修改：${outside.join(', ')}`,
        judgedBy: session.options.role.name === 'verifier' ? 'verifier' : 'system',
      };
    }

    return {
      criterionId: criterion.id,
      status: 'unverified',
      judgedBy: criterion.type === 'human' ? 'human' : 'verifier',
    };
  }

  private matchesScope(file: string, scope: string): boolean {
    const normalized = scope
      .replaceAll('\\', '/')
      .replace(/^\.\//, '')
      .replace(/\/\*+$/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
    if (normalized === '' || normalized === '**') return true;
    const target = file.replaceAll('\\', '/').toLowerCase();
    return target === normalized || target.startsWith(`${normalized}/`);
  }

  private async changedFiles(session: MockSession): Promise<string[]> {
    if (!session.baseHead) return [];
    const result = await git(session.worktree, [
      'diff',
      '--name-only',
      `${session.baseHead}..HEAD`,
    ]);
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async collectArtifacts(
    session: MockSession,
    task: TaskContract,
    acceptance: AcceptanceResult[],
    artifactsDir: string,
  ): Promise<ArtifactRef[]> {
    const artifacts: ArtifactRef[] = [];
    const changed = await this.changedFiles(session);
    if (session.baseHead && changed.length > 0) {
      const patch = await git(session.worktree, ['diff', `${session.baseHead}..HEAD`]);
      const numstat = await git(session.worktree, [
        'diff',
        '--numstat',
        `${session.baseHead}..HEAD`,
      ]);
      let additions = 0;
      let deletions = 0;
      for (const line of numstat.stdout.split(/\r?\n/)) {
        const [added, removed] = line.split('\t');
        additions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
      const diffPath = path.join(artifactsDir, 'diff.patch');
      await writeFile(diffPath, patch.stdout, 'utf8');
      artifacts.push({
        type: 'diff',
        path: diffPath,
        label: `${changed.length} 个文件`,
        meta: { files: changed.length, additions, deletions },
      });
    }

    if (session.options.role.name === 'verifier') {
      const reportPath = path.join(artifactsDir, 'verification.md');
      const lines = [
        `# 校验报告：${task.title}`,
        '',
        ...acceptance.map(
          (item) => `- ${item.criterionId}: ${item.status}${item.evidence ? `（${item.evidence}）` : ''}`,
        ),
      ];
      await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
      artifacts.push({ type: 'report', path: reportPath, label: '校验报告' });
    }

    return artifacts;
  }
}
