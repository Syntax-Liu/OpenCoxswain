/**
 * 撤销测试。
 *
 * 核心约束：**文件被后续改过时必须拒绝**。
 * 静默覆盖用户的手工修改，比不撤销糟得多。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { MemorySnapshotStore } from '../security/snapshot.js';
import { isUndoable, undoFileWrite } from '../security/undo.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-undo-'));
  temps.push(d);
  return d;
}

describe('撤销已有文件的修改', () => {
  it('**恢复到改动前的内容**', async () => {
    const root = await tmp();
    const file = path.join(root, 'a.txt');
    await writeFile(file, '原始内容', 'utf8');

    const snap = new MemorySnapshotStore();
    await snap.save('se_1', root, 'a.txt');

    // Agent 改了它
    await writeFile(file, '被改了', 'utf8');

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_1',
      relativePath: 'a.txt',
      expectedContent: '被改了',
    });

    assert.equal(r.ok, true);
    assert.equal(await readFile(file, 'utf8'), '原始内容');
  });

  it('子目录里的文件也能撤', async () => {
    const root = await tmp();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'b.ts'), 'old', 'utf8');

    const snap = new MemorySnapshotStore();
    await snap.save('se_2', root, 'src/b.ts');
    await writeFile(path.join(root, 'src', 'b.ts'), 'new', 'utf8');

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_2',
      relativePath: 'src/b.ts',
      expectedContent: 'new',
    });

    assert.equal(r.ok, true);
    assert.equal(await readFile(path.join(root, 'src', 'b.ts'), 'utf8'), 'old');
  });
});

describe('撤销新建的文件', () => {
  it('**原文件不存在 → 撤销即删除**', async () => {
    const root = await tmp();

    const snap = new MemorySnapshotStore();
    const saved = await snap.save('se_3', root, 'created.txt');
    assert.equal(saved.existed, false);

    // Agent 新建了它
    await writeFile(path.join(root, 'created.txt'), '新文件', 'utf8');

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_3',
      relativePath: 'created.txt',
      expectedContent: '新文件',
    });

    assert.equal(r.ok, true);
    assert.match(r.message, /删除/);

    // 文件应该没了
    await assert.rejects(() => readFile(path.join(root, 'created.txt')), '文件应当被删除');
  });
});

describe('**拒绝覆盖后续修改**', () => {
  it('文件在 Agent 改完后又被改过 → 拒绝', async () => {
    const root = await tmp();
    const file = path.join(root, 'c.txt');
    await writeFile(file, '原始', 'utf8');

    const snap = new MemorySnapshotStore();
    await snap.save('se_4', root, 'c.txt');

    // Agent 改成 A
    await writeFile(file, 'Agent改的', 'utf8');
    // 用户又手动改成 B
    await writeFile(file, '用户手动改的', 'utf8');

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_4',
      relativePath: 'c.txt',
      expectedContent: 'Agent改的', // 预期是 A，实际是 B
    });

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'changed-after');
    assert.match(r.message, /又被修改/);

    // **内容必须没被动过**
    assert.equal(await readFile(file, 'utf8'), '用户手动改的');
  });

  it('拒绝时给出明确下一步', async () => {
    const root = await tmp();
    const file = path.join(root, 'd.txt');
    await writeFile(file, 'a', 'utf8');
    const snap = new MemorySnapshotStore();
    await snap.save('se_5', root, 'd.txt');
    await writeFile(file, 'c', 'utf8');

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_5',
      relativePath: 'd.txt',
      expectedContent: 'b',
    });
    assert.match(r.message, /手工处理/);
  });
});

describe('快照缺失', () => {
  it('没有快照时明确说明，不假装成功', async () => {
    const root = await tmp();
    const snap = new MemorySnapshotStore();

    const r = await undoFileWrite({
      snapshot: snap,
      rootPath: root,
      sideEffectId: 'se_none',
      relativePath: 'x.txt',
    });

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-snapshot');
    assert.match(r.message, /找不到/);
  });
});

describe('哪些能撤', () => {
  it('**文件写入能撤**（台账里的实际类型名是 fs.write）', () => {
    assert.equal(isUndoable('fs.write', true), true);
  });

  it('**命令执行不能撤**（即使标了可逆）', () => {
    assert.equal(isUndoable('proc.exec', true), false);
  });

  it('网络发送不能撤', () => {
    assert.equal(isUndoable('net.send', true), false);
  });

  it('标了不可逆的一律不能撤', () => {
    assert.equal(isUndoable('fs.write', false), false);
  });
});
