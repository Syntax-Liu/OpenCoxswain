import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectArtifacts } from '@opencoxswain/adapters';
import type { Project, Task } from '@opencoxswain/shared';
import { parseDiffPatch } from '../diff-review.js';
import { runGit } from '../git.js';
import { WorktreeManager } from '../worktree.js';

/** Windows 专项：仓库、worktree、产物目录都带中文与空格，文件名同样带中文与空格。 */
interface CnFixture {
  temp: string;
  home: string;
  repo: string;
}

async function makeCnRepo(): Promise<CnFixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-cn-'));
  const repo = path.join(temp, '中文 仓库');
  const home = path.join(temp, '工作 区');
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(repo, '说明 文档.md'), 'base\n', 'utf8');
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'OpenCoxswain Test']);
  await runGit(repo, ['config', 'user.email', 'test@opencoxswain.local']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'init']);
  return { temp, home, repo };
}

function projectOf(repo: string): Project {
  return {
    id: 'proj',
    name: '中文项目',
    path: repo,
    defaultBranch: 'main',
    dailyBudgetUsd: 10,
    maxConcurrency: 2,
    allowNetwork: true,
    allowExternalSend: false,
    createdAt: Date.now(),
  };
}

function taskOf(id: string): Task {
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

function expectRawName(value: string): void {
  assert.ok(!value.includes('"'), `路径不应被引号包裹：${value}`);
  assert.ok(!/\\[0-7]{3}/.test(value), `路径不应包含八进制转义：${value}`);
}

test('Windows 中文与空格路径：worktree 创建、检视、合并、清理全程不转义', async () => {
  const fixture = await makeCnRepo();
  try {
    await runGit(fixture.repo, ['checkout', '-b', 'b1']);
    await writeFile(path.join(fixture.repo, '新增 文件.md'), 'changed\n', 'utf8');
    await runGit(fixture.repo, ['add', '-A']);
    await runGit(fixture.repo, ['commit', '-m', 'b1 增加中文文件']);
    await runGit(fixture.repo, ['checkout', 'main']);

    const manager = new WorktreeManager(fixture.home);
    const project = projectOf(fixture.repo);
    const created = await manager.create(project, taskOf('task-cn'));

    assert.ok(created.path.includes('工作 区'), created.path);
    assert.equal(
      (await readFile(path.join(created.path, '说明 文档.md'), 'utf8')).trim(),
      'base',
      '中文文件名在 worktree 内可读',
    );

    const state = await manager.inspect(project, ['b1']);
    const paths = state.diffs[0]?.paths ?? [];
    assert.deepEqual(paths, ['新增 文件.md'], '检视结果保留中文原名');
    for (const name of paths) expectRawName(name);

    const merged = await manager.merge(project, ['b1']);
    assert.deepEqual(merged.branches, ['b1']);
    assert.equal(
      (await readFile(path.join(fixture.repo, '新增 文件.md'), 'utf8')).trim(),
      'changed',
    );

    await manager.remove(project.path, created.path);
    await assert.rejects(() => stat(created.path), 'worktree 目录已清理');
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Windows 中文与空格路径：diff 产物与逐文件明细使用原始文件名', async () => {
  const fixture = await makeCnRepo();
  try {
    const baseHead = (await runGit(fixture.repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(fixture.repo, '新增 文件.md'), 'line1\nline2\n', 'utf8');
    await runGit(fixture.repo, ['add', '-A']);
    await runGit(fixture.repo, ['commit', '-m', '增加中文文件']);
    const artifactsDir = path.join(fixture.temp, '产物 目录');
    await mkdir(artifactsDir, { recursive: true });

    const artifacts = await collectArtifacts({
      worktree: fixture.repo,
      baseHead,
      artifactsDir,
      task: taskOf('task-cn').contract,
      roleName: 'implementer',
      acceptance: [],
    });
    const diff = artifacts.find((item) => item.type === 'diff');
    assert.ok(diff, '产出 diff 产物');
    const paths = (diff.meta?.paths ?? []) as string[];
    assert.deepEqual(paths, ['新增 文件.md'], '产物路径保留中文原名');
    for (const name of paths) expectRawName(name);

    const patch = await readFile(diff.path, 'utf8');
    const parsed = parseDiffPatch(patch);
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0]?.path, '新增 文件.md');
    assert.equal(parsed.files[0]?.status, 'added');
    assert.equal(parsed.files[0]?.additions, 2);
    expectRawName(parsed.files[0]?.path ?? '');
  } finally {
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
