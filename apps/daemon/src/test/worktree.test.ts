import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Task } from '@opencoxswain/shared';
import { runGit } from '../git.js';
import { MergeConflictError, WorktreeManager } from '../worktree.js';
import { makeRepo } from './helpers.js';

function projectOf(repo: string): Project {
  return {
    id: 'proj',
    name: 'proj',
    path: repo,
    defaultBranch: 'main',
    dailyBudgetUsd: 10,
    maxConcurrency: 2,
    allowNetwork: true,
    allowExternalSend: false,
    createdAt: Date.now(),
  };
}

function taskOf(id: string, repo: string): Task {
  return {
    id,
    projectId: 'proj',
    parentId: 'root',
    title: id,
    goal: id,
    status: 'queued',
    assigneeId: null,
    contract: {
      task_id: id,
      parent_id: 'root',
      project_id: 'proj',
      title: id,
      goal: id,
      deliverables: [],
      acceptance_criteria: [],
      dependencies: [],
      budget: {},
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function commitFile(repo: string, content: string): Promise<void> {
  await writeFile(path.join(repo, 'a.txt'), content, 'utf8');
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', `set ${content.trim()}`]);
}

test('顺序合并：多依赖分支冲突时抛出 MergeConflictError 并清理 worktree', async () => {
  const fixture = await makeRepo({ 'a.txt': 'base\n' });
  try {
    await runGit(fixture.repo, ['checkout', '-b', 'b1']);
    await commitFile(fixture.repo, 'b1\n');
    await runGit(fixture.repo, ['checkout', 'main']);
    await runGit(fixture.repo, ['checkout', '-b', 'b2']);
    await commitFile(fixture.repo, 'b2\n');
    await runGit(fixture.repo, ['checkout', 'main']);

    const manager = new WorktreeManager(fixture.home);
    const project = projectOf(fixture.repo);
    const worktree = path.join(fixture.home, project.id, 'task1');

    await assert.rejects(
      () => manager.create(project, taskOf('task1', fixture.repo), ['b1', 'b2']),
      (error: unknown) => error instanceof MergeConflictError,
      '冲突分支合并失败',
    );
    await assert.rejects(
      () => readFile(path.join(worktree, 'a.txt'), 'utf8'),
      '冲突后 worktree 已清理',
    );
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('顺序合并：单依赖正常检出且内容正确', async () => {
  const fixture = await makeRepo({ 'a.txt': 'base\n' });
  try {
    await runGit(fixture.repo, ['checkout', '-b', 'b1']);
    await commitFile(fixture.repo, 'b1\n');
    await runGit(fixture.repo, ['checkout', 'main']);

    const manager = new WorktreeManager(fixture.home);
    const project = projectOf(fixture.repo);
    const created = await manager.create(project, taskOf('task2', fixture.repo), ['b1']);

    assert.equal((await readFile(path.join(created.path, 'a.txt'), 'utf8')).trim(), 'b1');
    const branch = await runGit(created.path, ['branch', '--show-current']);
    assert.equal(branch.stdout.trim(), created.branch);
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
