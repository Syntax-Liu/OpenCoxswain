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

export class MergeConflictError extends Error {
  constructor(readonly ref: string, detail: string) {
    super(`合并 ${ref} 产生冲突：${detail}`);
    this.name = 'MergeConflictError';
  }
}

export class WorktreeManager {
  constructor(private readonly root: string) {}

  /** `baseRefs` 按依赖顺序合并；多依赖时在新 worktree 内逐个 merge，冲突则中止并抛出。 */
  async create(
    project: Project,
    task: Task,
    baseRefs: string[] = [],
  ): Promise<{ path: string; branch: string }> {
    const target = path.join(this.root, project.id, task.id);
    const branch = `opencoxswain/${task.id}`;
    await mkdir(path.dirname(target), { recursive: true });

    if (await exists(target)) {
      await this.remove(project.path, target);
    }

    const bases = baseRefs.length > 0 ? baseRefs : [project.defaultBranch];
    const base = bases[0]!;
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

    for (const ref of bases.slice(1)) {
      const merge = await runGit(target, ['merge', '--no-ff', '--no-edit', ref]);
      if (merge.code !== 0) {
        await runGit(target, ['merge', '--abort']);
        await this.remove(project.path, target);
        throw new MergeConflictError(ref, (merge.stderr || merge.stdout).trim().slice(0, 500));
      }
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
