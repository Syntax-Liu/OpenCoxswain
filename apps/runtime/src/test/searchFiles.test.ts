import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createExecutorToolHost } from '../executor/executor.js';

/**
 * search_files 的正则 / glob / 多匹配行。
 *
 * ## 之前的问题
 *
 * 只有字面 `includes`，且**每个文件只返回第一个匹配行**。
 * 模型想找"所有调用 foo 的地方"，拿到的信息远远不够。
 */
describe('search_files', () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ocx-search-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });

    await writeFile(
      join(root, 'src/a.ts'),
      ['const x = 1;', 'function foo() {}', 'function bar() {}', 'foo();', 'foo();'].join('\n'),
      'utf8',
    );
    await writeFile(join(root, 'src/b.tsx'), 'export function foo() {}\n', 'utf8');
    await writeFile(join(root, 'docs/readme.md'), 'foo is a function\n', 'utf8');
    await writeFile(join(root, 'src/data.bin'), 'foo\u0000binary', 'utf8');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const host = (): ReturnType<typeof createExecutorToolHost> =>
    createExecutorToolHost({ rootPath: root, writeScope: [] });

  it('**返回所有匹配行，不是只返回第一个**', async () => {
    const r = await host().execute({ name: 'search_files', args: { query: 'foo' } });
    assert.equal(r.ok, true, r.content);
    const lines = r.content.split('\n');
    // a.ts 里有 4 处 foo（声明 + 2 次调用 + ...），加上 b.tsx 和 readme.md
    assert.ok(lines.length >= 4, `应该多处匹配，实际 ${lines.length} 行:\n${r.content}`);
    // 每行都带行号
    assert.match(r.content, /src\/a\.ts:\d+:/);
  });

  it('正则能匹配模式', async () => {
    const r = await host().execute({
      name: 'search_files',
      args: { query: 'function\\s+\\w+\\(\\)', regex: true },
    });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /function foo\(\)/);
    assert.match(r.content, /function bar\(\)/);
  });

  it('glob 限定文件类型', async () => {
    const r = await host().execute({
      name: 'search_files',
      args: { query: 'foo', glob: '**/*.tsx' },
    });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /b\.tsx/);
    assert.doesNotMatch(r.content, /readme\.md/, 'glob 应该排掉 md');
    assert.doesNotMatch(r.content, /a\.ts:/, 'glob 应该排掉 ts');
  });

  it('**跳过二进制文件**（含 NUL）', async () => {
    const r = await host().execute({ name: 'search_files', args: { query: 'binary' } });
    assert.doesNotMatch(r.content, /data\.bin/);
  });

  it('坏正则退回字面匹配，不报错', async () => {
    const r = await host().execute({
      name: 'search_files',
      args: { query: '[unclosed', regex: true },
    });
    assert.equal(r.ok, true, '坏正则不该让工具失败');
  });

  it('context 带上下文行', async () => {
    const r = await host().execute({
      name: 'search_files',
      args: { query: 'function bar', context: 1 },
    });
    assert.equal(r.ok, true, r.content);
    assert.match(r.content, /-:/, '应该有前置上下文标记');
    assert.match(r.content, /\+:/, '应该有后置上下文标记');
  });

  it('没命中时给明确提示', async () => {
    const r = await host().execute({
      name: 'search_files',
      args: { query: 'zzz-not-exist-zzz' },
    });
    assert.equal(r.ok, true);
    assert.match(r.content, /没有命中/);
  });

  it('结果带行号', async () => {
    const r = await host().execute({ name: 'search_files', args: { query: 'bar' } });
    // a.ts 第 3 行有 bar
    assert.match(r.content, /a\.ts:3:/);
  });
});
