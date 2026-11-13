import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectRepo, RepoInspectError, runGit } from '../git.js';

async function expectFailure(
  promise: Promise<unknown>,
  code: string,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepoInspectError, `应抛出 RepoInspectError：${String(error)}`);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    return true;
  });
}

test('接入仓库失败：缺失、非目录、非 git、空仓库都给可读原因', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-git-'));
  try {
    await expectFailure(
      inspectRepo(path.join(root, 'no-such-dir')),
      'missing',
      /路径不存在/,
    );

    const file = path.join(root, 'notes.txt');
    await writeFile(file, 'hi\n', 'utf8');
    await expectFailure(inspectRepo(file), 'not_directory', /这不是文件夹/);

    const plain = path.join(root, 'plain');
    await mkdir(plain);
    await expectFailure(inspectRepo(plain), 'not_git', /不是 git 仓库/);

    const empty = path.join(root, 'empty');
    await mkdir(empty);
    await runGit(empty, ['init', '-b', 'main']);
    await expectFailure(inspectRepo(empty), 'empty_repo', /还没有任何提交/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('接入仓库成功：返回仓库根目录与当前分支', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-git-'));
  const repo = path.join(root, 'ready');
  try {
    await mkdir(repo);
    await runGit(repo, ['init', '-b', 'main']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n', 'utf8');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, [
      '-c',
      'user.name=OpenCoxswain',
      '-c',
      'user.email=coxswain@localhost',
      'commit',
      '-m',
      'init',
    ]);

    const info = await inspectRepo(repo);
    assert.equal(info.root, path.resolve(repo));
    assert.equal(info.branch, 'main');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
