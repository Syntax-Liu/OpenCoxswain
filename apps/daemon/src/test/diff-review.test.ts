import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiffPatch } from '../diff-review.js';

test('逐文件 diff：识破新增、删除、重命名与行数', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    '+extra',
    'diff --git a/old.txt b/new.txt',
    'similarity index 100%',
    'rename from old.txt',
    'rename to new.txt',
    'diff --git a/added.md b/added.md',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/added.md',
    '@@ -0,0 +1,2 @@',
    '+# 标题',
    '+正文',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 4444444..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');

  const { files, omitted } = parseDiffPatch(patch);
  assert.equal(omitted, 0);
  assert.equal(files.length, 4);

  const modified = files.find((file) => file.path === 'src/a.ts');
  assert.equal(modified?.status, 'modified');
  assert.equal(modified?.additions, 2);
  assert.equal(modified?.deletions, 1);
  assert.match(modified?.hunks ?? '', /\+extra/);

  const renamed = files.find((file) => file.path === 'new.txt');
  assert.equal(renamed?.status, 'renamed');
  assert.equal(renamed?.oldPath, 'old.txt');

  const added = files.find((file) => file.path === 'added.md');
  assert.equal(added?.status, 'added');
  assert.equal(added?.additions, 2);
  assert.equal(added?.deletions, 0);

  const deleted = files.find((file) => file.path === 'gone.txt');
  assert.equal(deleted?.status, 'deleted');
  assert.equal(deleted?.additions, 0);
  assert.equal(deleted?.deletions, 1);
});

test('逐文件 diff：二进制明确提示，不静默隐藏', () => {
  const patch = [
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'index 0000000..5555555',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n');

  const { files } = parseDiffPatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.binary, true);
  assert.equal(files[0]?.hunks, '');
  assert.match(files[0]?.notice ?? '', /二进制/);
});

test('逐文件 diff：大文件截断必须带提示', () => {
  const body = Array.from({ length: 40 }, (_, index) => `+line ${index}`).join('\n');
  const patch = [
    'diff --git a/big.txt b/big.txt',
    'index 1111111..2222222 100644',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -0,0 +1,40 @@',
    body,
  ].join('\n');

  const { files } = parseDiffPatch(patch, { maxFileChars: 80 });
  assert.equal(files[0]?.truncated, true);
  assert.ok((files[0]?.hunks.length ?? 0) <= 80);
  assert.match(files[0]?.notice ?? '', /完整内容请查看原始 diff 产物/);
});

test('逐文件 diff：超过文件上限时计入 omitted', () => {
  const sections = Array.from({ length: 3 }, (_, index) =>
    [
      `diff --git a/f${index}.txt b/f${index}.txt`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/f${index}.txt`,
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n'),
  );
  const { files, omitted } = parseDiffPatch(sections.join('\n'), { maxFiles: 2 });
  assert.equal(files.length, 2);
  assert.equal(omitted, 1);
});
