import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 中文路径默认会被 git 转义成八进制，统一关掉，让路径原样返回。 */
const QUOTEPATH_OFF = ['-c', 'core.quotepath=false'];

export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      [...QUOTEPATH_OFF, ...args],
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export interface RepoInfo {
  root: string;
  branch: string;
}

export type RepoInspectCode =
  | 'missing'
  | 'not_directory'
  | 'forbidden'
  | 'not_git'
  | 'git_unavailable'
  | 'empty_repo';

/** 接入仓库失败：message 直接给用户看，不让界面只看到错误码。 */
export class RepoInspectError extends Error {
  constructor(
    readonly code: RepoInspectCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepoInspectError';
  }
}

function describeGitFailure(repoPath: string, stderr: string): RepoInspectError {
  const detail = stderr.trim();
  if (/permission denied|access is denied|权限/i.test(detail)) {
    return new RepoInspectError(
      'forbidden',
      `没有权限读取这个仓库：${repoPath}。请换一个有读取权限的目录，或调整文件夹权限后重试。`,
    );
  }
  if (/not a git repository/i.test(detail)) {
    return new RepoInspectError(
      'not_git',
      `这里不是 git 仓库：${repoPath}。请先在终端运行 git init，或换一个已有仓库。`,
    );
  }
  if (!detail) {
    return new RepoInspectError(
      'git_unavailable',
      '没有找到可用的 git。请先安装 git，并确认终端里能直接运行 git --version。',
    );
  }
  return new RepoInspectError(
    'not_git',
    `无法读取 git 仓库信息：${repoPath}。git 返回：${detail}`,
  );
}

export async function inspectRepo(repoPath: string): Promise<RepoInfo> {
  let info: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    info = await stat(repoPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new RepoInspectError(
        'missing',
        `路径不存在：${repoPath}。请检查路径是否写错，或先创建这个文件夹。`,
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RepoInspectError(
        'forbidden',
        `没有权限访问：${repoPath}。请换一个有读取权限的目录，或调整文件夹权限后重试。`,
      );
    }
    throw new RepoInspectError(
      'missing',
      `无法访问路径：${repoPath}${code ? `（${code}）` : ''}。请检查路径后重试。`,
    );
  }
  if (!info.isDirectory()) {
    throw new RepoInspectError(
      'not_directory',
      `这不是文件夹：${repoPath}。请填写仓库根目录，而不是文件。`,
    );
  }
  const root = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) {
    throw describeGitFailure(repoPath, root.stderr);
  }
  const resolvedRoot = path.resolve(root.stdout.trim());
  const head = await runGit(resolvedRoot, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    throw new RepoInspectError(
      'empty_repo',
      `仓库还没有任何提交：${resolvedRoot}。请先提交一次，再接入。`,
    );
  }
  const branch = await runGit(resolvedRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    root: resolvedRoot,
    branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : 'main',
  };
}
