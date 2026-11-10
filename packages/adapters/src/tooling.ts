import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AcceptanceCriterion,
  AcceptanceResult,
  ArtifactRef,
  TaskContract,
} from '@opencoxswain/shared';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function truncate(text: string, length = 800): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Windows 进程工作目录上限 260 字符；超过后 spawn 会失败，且 Node 抛出不可捕获的 ENOTCONN。 */
const WINDOWS_MAX_CWD = 258;

function longCwdError(cwd: string): string | null {
  if (process.platform !== 'win32') return null;
  const resolved = path.resolve(cwd);
  return resolved.length > WINDOWS_MAX_CWD
    ? `工作目录路径过长（${resolved.length} 个字符，Windows 上限 260）：${resolved}。请把仓库或工作区移到更短的路径后重试。`
    : null;
}

/** 按 PID 结束整棵进程树；进程已退出时静默返回。 */
export async function killPidTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出。
    }
  }
}

/**
 * 结束整棵进程树。
 *
 * Windows 上 `shell: true` 起的是 cmd.exe，`child.kill()` 只杀外壳，
 * 被执行的命令及其孙进程会残留并占用 worktree 文件。POSIX 上对应的是
 * `/bin/sh -c`，需要按进程组杀（调用方要传 `detached: true`）。
 */
export async function killTree(
  child: ChildProcess | null,
  options: { group?: boolean } = {},
): Promise<void> {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return;
    await killPidTree(child.pid);
    return;
  }
  if (options.group) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // 不是进程组，退回单进程。
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 进程已退出。
  }
}

export function runCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  const tooLong = longCwdError(cwd);
  if (tooLong) return Promise.resolve({ code: -1, stdout: '', stderr: tooLong });
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => void killTree(child, { group: true }), timeoutMs);
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

/** 中文路径默认会被 git 转义成八进制；长路径默认报 Filename too long，两项都交给 git 自己处理。 */
const GIT_CONFIG = ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true'];

export function git(cwd: string, args: string[]): Promise<CommandResult> {
  const tooLong = longCwdError(cwd);
  if (tooLong) return Promise.resolve({ code: 1, stdout: '', stderr: tooLong });
  return new Promise((resolve) => {
    execFile(
      'git',
      [...GIT_CONFIG, ...args],
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

export function isWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root).toLowerCase();
  const normalizedTarget = path.resolve(target).toLowerCase();
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export async function headOf(cwd: string): Promise<string | null> {
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  return head.code === 0 ? head.stdout.trim() : null;
}

export async function commitChanges(cwd: string, message: string): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain']);
  if (status.code !== 0 || status.stdout.trim() === '') return false;
  await git(cwd, ['add', '-A']);
  const commit = await git(cwd, [
    '-c',
    'user.name=OpenCoxswain',
    '-c',
    'user.email=coxswain@localhost',
    'commit',
    '-m',
    message,
  ]);
  return commit.code === 0;
}

export function matchesScope(file: string, scope: string): boolean {
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

export async function changedFiles(cwd: string, baseHead: string | null): Promise<string[]> {
  if (!baseHead) return [];
  const result = await git(cwd, ['diff', '--name-only', `${baseHead}..HEAD`]);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface JudgeOptions {
  worktree: string;
  baseHead: string | null;
  roleName: string;
  writeScope: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export async function judgeCriterion(
  criterion: AcceptanceCriterion,
  options: JudgeOptions,
): Promise<AcceptanceResult> {
  if (criterion.type === 'command') {
    if (!criterion.check) {
      return { criterionId: criterion.id, status: 'unverified', judgedBy: 'system' };
    }
    const result = await runCommand(criterion.check, options.worktree, options.env, options.timeoutMs);
    return {
      criterionId: criterion.id,
      status: result.code === 0 ? 'passed' : 'failed',
      evidence: `exit ${result.code}: ${truncate(`${result.stdout}${result.stderr}`.trim())}`,
      judgedBy: 'system',
    };
  }

  if (criterion.type === 'diff') {
    const changed = await changedFiles(options.worktree, options.baseHead);
    if (changed.length === 0) {
      return {
        criterionId: criterion.id,
        status: 'failed',
        evidence: '没有产生变更',
        judgedBy: 'system',
      };
    }
    const outside = options.writeScope.length === 0
      ? []
      : changed.filter((file) => !options.writeScope.some((prefix) => matchesScope(file, prefix)));
    return {
      criterionId: criterion.id,
      status: outside.length === 0 ? 'passed' : 'failed',
      evidence:
        outside.length === 0
          ? `变更文件：${changed.join(', ')}`
          : `越界修改：${outside.join(', ')}`,
      judgedBy: options.roleName === 'verifier' ? 'verifier' : 'system',
    };
  }

  return {
    criterionId: criterion.id,
    status: 'unverified',
    judgedBy: criterion.type === 'human' ? 'human' : 'verifier',
  };
}

export interface ArtifactOptions {
  worktree: string;
  baseHead: string | null;
  task: TaskContract;
  roleName: string;
  acceptance: AcceptanceResult[];
  artifactsDir: string;
}

export async function collectArtifacts(options: ArtifactOptions): Promise<ArtifactRef[]> {
  const artifacts: ArtifactRef[] = [];
  const changed = await changedFiles(options.worktree, options.baseHead);
  if (options.baseHead && changed.length > 0) {
    const patch = await git(options.worktree, ['diff', `${options.baseHead}..HEAD`]);
    const numstat = await git(options.worktree, [
      'diff',
      '--numstat',
      `${options.baseHead}..HEAD`,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split(/\r?\n/)) {
      const [added, removed] = line.split('\t');
      additions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
    const diffPath = path.join(options.artifactsDir, 'diff.patch');
    await writeFile(diffPath, patch.stdout, 'utf8');
    artifacts.push({
      type: 'diff',
      path: diffPath,
      label: `${changed.length} 个文件`,
      meta: {
        files: changed.length,
        additions,
        deletions,
        paths: changed,
        patchHash: createHash('sha256').update(patch.stdout).digest('hex'),
      },
    });
  }

  if (options.roleName === 'verifier') {
    const reportPath = path.join(options.artifactsDir, 'verification.md');
    const lines = [
      `# 校验报告：${options.task.title}`,
      '',
      ...options.acceptance.map(
        (item) => `- ${item.criterionId}: ${item.status}${item.evidence ? `（${item.evidence}）` : ''}`,
      ),
    ];
    await writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
    artifacts.push({ type: 'report', path: reportPath, label: '校验报告' });
  }

  return artifacts;
}
