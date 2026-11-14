import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createExecutorToolHost } from '../executor/executor.js';

/**
 * `dry_run` 与 diff 返回。
 *
 * ## 为什么必须有这条测试
 *
 * `dry_run` 的语义是「**不写文件**」。如果漏了 early return，
 * 就会变成"说了不写但写了"——比没有这个功能更危险。
 */
describe('edit_file / write_file 的 dry_run', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocx-dry-'));
    await writeFile(join(root, 'a.txt'), 'line1\nline2\nline3\n', 'utf8');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const host = (readonlyTask = false): ReturnType<typeof createExecutorToolHost> =>
    createExecutorToolHost({
      rootPath: root,
      writeScope: [],
      ...(readonlyTask ? { readonlyTask: true } : {}),
    });

  it('**edit_file dry_run 不写文件**', async () => {
    const h = host();
    const before = await readFile(join(root, 'a.txt'), 'utf8');

    const r = await h.execute({
      name: 'edit_file',
      args: { path: 'a.txt', old_text: 'line2', new_text: 'CHANGED', dry_run: true },
    });

    assert.equal(r.ok, true, r.content);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), before, '文件不该被改');
    assert.match(r.content, /预演，未写入/);
    assert.match(r.content, /-line2/);
    assert.match(r.content, /\+CHANGED/);
  });

  it('edit_file 正常写入时也返回 diff', async () => {
    const h = host();
    const r = await h.execute({
      name: 'edit_file',
      args: { path: 'a.txt', old_text: 'line2', new_text: 'line2-mod' },
    });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /已修改/);
    assert.match(r.content, /\+line2-mod/);
    assert.match(await readFile(join(root, 'a.txt'), 'utf8'), /line2-mod/);
  });

  it('**write_file dry_run 不创建文件**', async () => {
    const h = host();
    const r = await h.execute({
      name: 'write_file',
      args: { path: 'brand-new.txt', content: 'hello\n', dry_run: true },
    });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /预演，未写入/);
    assert.match(r.content, /\+hello/);

    let exists = true;
    try {
      await readFile(join(root, 'brand-new.txt'), 'utf8');
    } catch {
      exists = false;
    }
    assert.equal(exists, false, 'dry_run 不能创建文件');
  });

  it('write_file 覆盖已有文件时 diff 显示旧内容', async () => {
    const h = host();
    await writeFile(join(root, 'b.txt'), 'old\ncontent\n', 'utf8');
    const r = await h.execute({
      name: 'write_file',
      args: { path: 'b.txt', content: 'new\ncontent\n', dry_run: true },
    });
    assert.match(r.content, /-old/);
    assert.match(r.content, /\+new/);
  });

  it('dry_run 也受只读任务限制', async () => {
    const h = host(true);
    const r = await h.execute({
      name: 'edit_file',
      args: { path: 'a.txt', old_text: 'line1', new_text: 'x', dry_run: true },
    });
    assert.equal(r.ok, false);
    assert.match(r.content, /只读/);
  });
});
