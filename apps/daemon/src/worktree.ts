import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Task } from '@opencoxswain/shared';
import { runGit } from './git.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null;
}

export class WorktreeManager {
  constructor(private readonly root: string) {}

  async create(
    project: Project,
    task: Task,
    baseRef?: string,
  ): Promise<{ path: string; branch: string }> {
    const target = path.join(this.root, project.id, task.id);
    const branch = `opencoxswain/${task.id}`;
    await mkdir(path.dirname(target), { recursive: true });

    if (await exists(target)) {
      await this.remove(project.path, target);
    }

    const base = baseRef ?? project.defaultBranch;
    let result = await runGit(project.path, ['worktree', 'add', '-b', branch, target, base]);
    if (result.code !== 0) {
      result = await runGit(project.path, ['worktree', 'add', target, branch]);
    }
    if (result.code !== 0) {
      await delay(200);
      result = await runGit(project.path, ['worktree', 'add', target, base]);
    }
    if (result.code !== 0) {
      throw new Error(`创建 worktree 失败：${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { path: target, branch };
  }

  /** Windows 文件锁常见，删除失败时重试；失败只上报，不阻塞状态恢复。 */
  async remove(repoPath: string, worktreePath: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await runGit(repoPath, ['worktree', 'remove', '--force', worktreePath]);
      if (result.code === 0) {
        await runGit(repoPath, ['worktree', 'prune']);
        return;
      }
      await delay(100 * 2 ** attempt);
    }
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await runGit(repoPath, ['worktree', 'prune']);
  }
}
