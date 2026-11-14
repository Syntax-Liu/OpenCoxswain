import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffStat, unifiedDiff } from '../executor/diff.js';

describe('unifiedDiff', () => {
  it('相同内容返回空', () => {
    const r = unifiedDiff('a\nb\n', 'a\nb\n');
    assert.equal(r.text, '');
    assert.equal(r.added, 0);
    assert.equal(r.removed, 0);
  });

  it('纯新增', () => {
    const r = unifiedDiff('a\n', 'a\nb\n', { path: 'x.ts' });
    assert.match(r.text, /\+b/);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 0);
  });

  it('纯删除', () => {
    const r = unifiedDiff('a\nb\n', 'a\n', { path: 'x.ts' });
    assert.match(r.text, /-b/);
    assert.equal(r.added, 0);
    assert.equal(r.removed, 1);
  });

  it('修改一行', () => {
    const r = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { path: 'x.ts' });
    assert.match(r.text, /-b/);
    assert.match(r.text, /\+B/);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 1);
  });

  it('带文件头', () => {
    const r = unifiedDiff('a\n', 'b\n', { path: 'src/foo.ts' });
    assert.match(r.text, /^--- a\/src\/foo\.ts/);
    assert.match(r.text, /^\+\+\+ b\/src\/foo\.ts/m);
  });

  it('带 hunk 头，行号正确', () => {
    // a/b/c/d/e → a/b/X/d/e，只改第 3 行
    const r = unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n', { path: 'x.ts' });
    assert.match(r.text, /@@ -1,5 \+1,5 @@/);
  });

  it('中间改动只带上下文，不输出全文', () => {
    const before = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const after = before.replace('line25', 'CHANGED');
    const r = unifiedDiff(before, after, { path: 'x.ts' });
    // 应该只有改动附近几行 + 文件头 + hunk 头
    const lines = r.text.split('\n');
    assert.ok(lines.length < 15, `应该只输出上下文，实际 ${lines.length} 行`);
    assert.match(r.text, /\+CHANGED/);
    assert.match(r.text, /-line25/);
  });

  it('全文替换', () => {
    const r = unifiedDiff('a\nb\n', 'x\ny\n', { path: 'x.ts' });
    assert.equal(r.removed, 2);
    assert.equal(r.added, 2);
  });

  it('空文件到有内容', () => {
    const r = unifiedDiff('', 'hello\n', { path: 'x.ts' });
    assert.match(r.text, /\+hello/);
  });

  it('有内容到空文件', () => {
    const r = unifiedDiff('hello\n', '', { path: 'x.ts' });
    assert.match(r.text, /-hello/);
  });

  it('超长时截断', () => {
    const before = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, i) => `L${i}`).join('\n');
    const r = unifiedDiff(before, after, { path: 'x.ts', maxLines: 50 });
    assert.equal(r.truncated, true);
    assert.match(r.text, /已截断/);
  });

  it('不改动 diff 的统计口径', () => {
    // 3 行变 5 行，中间改了 1 行
    const r = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\ne\n', { path: 'x.ts' });
    assert.equal(r.removed, 1); // b
    assert.equal(r.added, 3); // B + d + e
  });
});

describe('diffStat', () => {
  it('格式是 +N -M', () => {
    const r = unifiedDiff('a\n', 'a\nb\nc\n', { path: 'x.ts' });
    assert.equal(diffStat(r), '+2 -0');
  });

  it('无变化', () => {
    assert.equal(diffStat(unifiedDiff('x', 'x')), '无变化');
  });
});
