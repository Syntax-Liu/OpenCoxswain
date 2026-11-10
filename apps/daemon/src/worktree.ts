import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Task } from '@opencoxswain/shared';
import type { RepositoryDiff, RepositoryState } from '@opencoxswain/plugin-api';
import { runGit, gitCwdTooLong, longPathMessage } from './git.js';

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
    if (gitCwdTooLong(target)) {
      throw new Error(`任务 ${task.id} 的 worktree 路径过长，git 无法在其中运行。${longPathMessage(target)}`);
    }
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

  /** 交付前检查：不动工作区，只读分支、状态与 diff。 */
  async inspect(project: Project, refs: string[]): Promise<RepositoryState> {
    const branch = await runGit(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = await runGit(project.path, ['rev-parse', 'HEAD']);
    const status = await runGit(project.path, ['status', '--porcelain']);
    const diffs: RepositoryDiff[] = [];
    for (const ref of refs) {
      const numstat = await runGit(project.path, [
        'diff',
        '--numstat',
        `${project.defaultBranch}...${ref}`,
      ]);
      if (numstat.code !== 0) {
        throw new Error(`读取 ${ref} 的改动失败：${(numstat.stderr || numstat.stdout).trim()}`);
      }
      let additions = 0;
      let deletions = 0;
      for (const line of numstat.stdout.split('\n')) {
        const [added, removed] = line.split('\t');
        additions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
      const names = await runGit(project.path, [
        'diff',
        '--name-only',
        `${project.defaultBranch}...${ref}`,
      ]);
      if (names.code !== 0) {
        throw new Error(`读取 ${ref} 的改动文件失败：${(names.stderr || names.stdout).trim()}`);
      }
      const paths = names.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      diffs.push({
        ref,
        files: paths.length,
        additions,
        deletions,
        paths,
      });
    }
    return {
      branch: branch.stdout.trim(),
      head: head.stdout.trim(),
      clean: status.stdout.trim().length === 0,
      diffs,
    };
  }

  /** 依次合入默认分支；任一步失败都先 abort 再 reset 回合并前提交。 */
  async merge(
    project: Project,
    refs: string[],
  ): Promise<{ baseBranch: string; head: string; branches: string[] }> {
    if (refs.length === 0) throw new Error('没有可合并的分支');
    const branch = (await runGit(project.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branch !== project.defaultBranch) {
      throw new Error(`当前分支是 ${branch}，请先切回 ${project.defaultBranch}`);
    }
    const status = await runGit(project.path, ['status', '--porcelain']);
    if (status.stdout.trim()) throw new Error('工作区有未提交改动，请先提交或清理');

    const original = (await runGit(project.path, ['rev-parse', 'HEAD'])).stdout.trim();
    const merged: string[] = [];
    try {
      for (const ref of refs) {
        const result = await runGit(project.path, ['merge', '--no-ff', '--no-edit', ref]);
        if (result.code !== 0) {
          throw new MergeConflictError(ref, (result.stderr || result.stdout).trim().slice(0, 500));
        }
        merged.push(ref);
      }
    } catch (error) {
      await runGit(project.path, ['merge', '--abort']);
      await runGit(project.path, ['reset', '--hard', original]);
      throw error;
    }
    const head = (await runGit(project.path, ['rev-parse', 'HEAD'])).stdout.trim();
    return { baseBranch: project.defaultBranch, head, branches: merged };
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
