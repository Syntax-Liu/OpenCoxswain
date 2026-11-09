import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
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

export async function inspectRepo(repoPath: string): Promise<RepoInfo> {
  const info = await stat(repoPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`路径不存在或不是目录：${repoPath}`);
  }
  const root = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
  if (root.code !== 0) {
    throw new Error(`不是 git 仓库：${repoPath}`);
  }
  const resolvedRoot = path.resolve(root.stdout.trim());
  const branch = await runGit(resolvedRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    root: resolvedRoot,
    branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : 'main',
  };
}
