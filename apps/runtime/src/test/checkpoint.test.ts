import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildCheckpoints, rollbackCheckpoint } from '../security/checkpoint.js';
import { FileSnapshotStore } from '../security/snapshot.js';
import type { SideEffectRow } from '../store/store.js';

/**
 * 检查点：把一轮的改动聚组 + 整轮回滚。
 *
 * ## 最要紧的一条
 *
 * **不能静默覆盖用户后来手工改过的文件。**
 * 这比"没回滚成功"糟得多。
 */

let counter = 0;
function row(over: Partial<SideEffectRow>): SideEffectRow {
  counter += 1;
  return {
    id: `eff_${counter}`,
    projectId: 'p1',
    executorId: 'exe_1',
    kind: 'fs.write',
    target: 'a.txt',
    state: 'succeeded',
    reversible: true,
    idempotencyKey: `k${counter}`,
    tool: 'write_file',
    args: '{}',
    note: null,
    createdAt: 1000,
    settledAt: 1001,
    ...over,
  };
}

describe('buildCheckpoints', () => {
  it('同一轮相邻的写入聚成一个检查点', () => {
    const rows = [
      row({ target: 'a.txt', createdAt: 1000 }),
      row({ target: 'b.txt', createdAt: 2000 }),
      row({ target: 'c.txt', createdAt: 3000 }),
    ];
    const cps = buildCheckpoints(rows, { executorId: 'exe_1' });
    assert.equal(cps.length, 1);
    assert.deepEqual([...cps[0]!.files].sort(), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('隔太久切开成两个检查点', () => {
    const rows = [
      row({ target: 'a.txt', createdAt: 1000 }),
      row({ target: 'b.txt', createdAt: 1000 + 20 * 60_000 }), // 20 分钟后
    ];
    const cps = buildCheckpoints(rows, { executorId: 'exe_1', gapMs: 10 * 60_000 });
    assert.equal(cps.length, 2);
  });

  it('不同执行器的分开', () => {
    const rows = [
      row({ executorId: 'exe_1', target: 'a.txt' }),
      row({ executorId: 'exe_2', target: 'b.txt' }),
    ];
    assert.equal(buildCheckpoints(rows, { executorId: 'exe_1' }).length, 1);
    assert.equal(buildCheckpoints(rows, { executorId: 'exe_2' }).length, 1);
  });

  it('只算文件写入，不算命令', () => {
    const rows = [
      row({ target: 'a.txt', kind: 'fs.write' }),
      row({ target: 'rm -rf /', kind: 'proc.exec' }),
    ];
    const cps = buildCheckpoints(rows, { executorId: 'exe_1' });
    assert.deepEqual(cps[0]!.files, ['a.txt']);
  });

  it('同一文件改多次只算一个路径', () => {
    const rows = [
      row({ target: 'a.txt', createdAt: 1000 }),
      row({ target: 'a.txt', createdAt: 2000 }),
    ];
    const cps = buildCheckpoints(rows, { executorId: 'exe_1' });
    assert.deepEqual(cps[0]!.files, ['a.txt']);
  });

  it('没有写入返回空', () => {
    assert.deepEqual(buildCheckpoints([], { executorId: 'exe_1' }), []);
  });
});

describe('rollbackCheckpoint', () => {
  let root: string;
  let snapDir: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocx-cp-root-'));
    snapDir = await mkdtemp(join(tmpdir(), 'ocx-cp-snap-'));
    await mkdir(join(root, 'src'), { recursive: true });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(snapDir, { recursive: true, force: true });
  });

  it('**恢复整轮改过的文件**', async () => {
    const snap = new FileSnapshotStore(snapDir);

    // 准备：两个文件的原始内容
    await writeFile(join(root, 'a.txt'), 'ORIGINAL A\n', 'utf8');
    await writeFile(join(root, 'b.txt'), 'ORIGINAL B\n', 'utf8');

    const e1 = row({ id: 'e1', target: 'a.txt', createdAt: 1000 });
    const e2 = row({ id: 'e2', target: 'b.txt', createdAt: 2000 });

    await snap.save(e1.id, root, 'a.txt');
    await snap.save(e2.id, root, 'b.txt');

    // Agent 改掉
    await writeFile(join(root, 'a.txt'), 'CHANGED A\n', 'utf8');
    await writeFile(join(root, 'b.txt'), 'CHANGED B\n', 'utf8');

    const cps = buildCheckpoints([e1, e2], { executorId: 'exe_1' });
    const r = await rollbackCheckpoint({
      snapshot: snap,
      rootPath: root,
      rows: [e1, e2],
      checkpoint: cps[0]!,
    });

    assert.equal(r.restored.length, 2, r.message);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'ORIGINAL A\n');
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'ORIGINAL B\n');
  });

  it('**不覆盖用户后来手工改过的文件**', async () => {
    const snap = new FileSnapshotStore(snapDir);

    await writeFile(join(root, 'c.txt'), 'ORIGINAL C\n', 'utf8');

    // write_file 的 args 里带完整 content，可用来检测"之后又被改过"
    const e = row({
      id: 'e3',
      target: 'c.txt',
      createdAt: 5000,
      args: JSON.stringify({ content: 'AGENT WROTE THIS\n' }),
    });
    await snap.save(e.id, root, 'c.txt');

    // Agent 写入
    await writeFile(join(root, 'c.txt'), 'AGENT WROTE THIS\n', 'utf8');
    // **用户又手工改了**
    await writeFile(join(root, 'c.txt'), 'USER EDITED\n', 'utf8');

    const cps = buildCheckpoints([e], { executorId: 'exe_1' });
    const r = await rollbackCheckpoint({
      snapshot: snap,
      rootPath: root,
      rows: [e],
      checkpoint: cps[0]!,
    });

    // 应该跳过，且文件保持用户的内容
    assert.equal(r.restored.length, 0, '不该恢复');
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0]!.path, 'c.txt');
    assert.equal(
      await readFile(join(root, 'c.txt'), 'utf8'),
      'USER EDITED\n',
      '**绝不能覆盖用户后来的修改**',
    );
  });

  it('不可逆的跳过并说明', async () => {
    const snap = new FileSnapshotStore(snapDir);
    const e = row({ id: 'e4', target: 'd.txt', reversible: false, createdAt: 9000 });
    const cps = buildCheckpoints([e], { executorId: 'exe_1' });
    const r = await rollbackCheckpoint({
      snapshot: snap,
      rootPath: root,
      rows: [e],
      checkpoint: cps[0]!,
    });
    assert.equal(r.restored.length, 0);
    assert.match(r.message, /跳过/);
  });

  it('没有快照时如实报告', async () => {
    const snap = new FileSnapshotStore(snapDir);
    const e = row({ id: 'e5', target: 'nosnap.txt', createdAt: 11000 });
    const cps = buildCheckpoints([e], { executorId: 'exe_1' });
    const r = await rollbackCheckpoint({
      snapshot: snap,
      rootPath: root,
      rows: [e],
      checkpoint: cps[0]!,
    });
    assert.equal(r.restored.length, 0);
    assert.equal(r.skipped.length, 1);
  });
});
