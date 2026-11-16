import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { diffLines, diffStats } from '../components/diff.js';
import { childrenOf } from '../components/FilePanel.js';

/**
 * 右栏「改动」和「文件」两个页签。
 *
 * ## 为什么需要
 *
 * 用户的原话：
 *
 * > 做一个调研，补一下功能，我目前能看到的就是 Diff、文件预览、浏览器等
 *
 * 调研发现：**后端 API 全都有**（文件列表 / 文件读取 / 副作用台账 / 文件快照），
 * 但**前端一个都没用上**——Diff、预览、文件树全是零。
 *
 * 而且右侧栏那张「工作区文件」卡片**点了没反应**：
 * `RailEmptyState` 接受 `onOpenFiles`，但 App.tsx 从没传过。
 */

describe('**行级 Diff 算法**', () => {
  it('完全相同 → 全是 same', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l.kind === 'same'));
  });

  it('改一行 → change（左右配对，方便并排读）', () => {
    const lines = diffLines('a\nb\nc', 'a\nX\nc');
    assert.equal(lines.length, 3);
    assert.equal(lines[1]?.kind, 'change');
    assert.equal(lines[1]?.left, 'b');
    assert.equal(lines[1]?.right, 'X');
  });

  it('加一行 → add，且右侧行号正确', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    const added = lines.find((l) => l.kind === 'add');
    assert.ok(added);
    assert.equal(added.left, null);
    assert.equal(added.right, 'b');
    assert.equal(added.rightNo, 2);
  });

  it('删一行 → remove', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    const removed = lines.find((l) => l.kind === 'remove');
    assert.ok(removed);
    assert.equal(removed.left, 'b');
    assert.equal(removed.right, null);
  });

  it('**新建文件**（before=null）→ 全是 add', () => {
    const lines = diffLines(null, 'x\ny');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.kind === 'add'));
    assert.ok(lines.every((l) => l.leftNo === null));
  });

  it('**删除文件**（after=null）→ 全是 remove', () => {
    const lines = diffLines('x\ny', null);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.kind === 'remove'));
  });

  it('增删统计正确', () => {
    const s = diffStats(diffLines('a\nb\nc', 'a\nX\nY\nc'));
    assert.equal(s.added, 2);
    assert.equal(s.removed, 1);
  });

  it('空内容不炸', () => {
    assert.deepEqual(diffLines('', ''), []);
  });
});

describe('**页签结构**', () => {
  const rail = readFileSync(
    new URL('../../src/components/RightRail.tsx', import.meta.url),
    'utf8',
  );

  it('是横向页签，不是纵向分区', () => {
    assert.match(rail, /role="tablist"/, '没有页签条');
    assert.match(rail, /role="tab"/, '没有页签');
  });

  it('**支持受控**（外部能切页签）', () => {
    assert.match(rail, /activeTab\?: string/, '不支持受控');
    assert.match(rail, /onTabChange\?:/, '没有切换回调');
  });

  it('有「改动」页签', () => {
    assert.match(rail, /id: 'changes'/, '没有改动页签');
  });

  it('**有「文件」页签**', () => {
    assert.match(rail, /id: 'files'/, '没有文件页签');
  });
});

describe('**「工作区文件」卡片不再点了没反应**', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');

  it('传了 onOpenFiles，且真的切到文件页', () => {
    assert.match(app, /onOpenFiles=/, 'onOpenFiles 还是没传');
    const start = app.indexOf('onOpenFiles=');
    const block = app.slice(start, start + 200);
    assert.match(block, /setRailTab\('files'\)/, '点了没切到文件页');
  });
});

describe('**文件树**', () => {
  const files = [
    { path: 'README.md', name: 'README.md', size: 10 },
    { path: 'src/a.ts', name: 'a.ts', size: 20 },
    { path: 'src/b.ts', name: 'b.ts', size: 30 },
    { path: 'src/deep/c.ts', name: 'c.ts', size: 40 },
  ];

  it('根层：目录 + 文件，目录在前', () => {
    const root = childrenOf(files, '');
    assert.deepEqual(
      root.map((n) => n.name),
      ['src', 'README.md'],
    );
    assert.equal(root[0]?.isDir, true);
  });

  it('展开 src：直接子项才算，深层归到子目录', () => {
    const children = childrenOf(files, 'src');
    assert.deepEqual(
      children.map((n) => n.name),
      ['deep', 'a.ts', 'b.ts'],
    );
  });

  it('空目录返回空数组', () => {
    assert.deepEqual(childrenOf(files, 'nope'), []);
  });
});
