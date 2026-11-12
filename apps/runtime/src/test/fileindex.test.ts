/**
 * @ 引用文件索引测试。
 *
 * 核心是要"打得少也能找到"：
 * 打 `log` 应该出 login.ts，打 `lt` 也应该能出。
 * 但也不能乱匹配——打 `abc` 出个毫不相干的文件比没有更烦人。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MAX_REFERENCE_BYTES,
  extractReferences,
  listFiles,
  renderReference,
  scoreFile,
  searchFiles,
  type FileEntry,
} from '../codeintel/fileindex.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-fi-'));
  temps.push(d);
  return d;
}

const file = (p: string): FileEntry => ({ path: p, name: p.split('/').pop() ?? p, size: 0 });

describe('扫描目录', () => {
  async function makeProject(): Promise<string> {
    const root = await tmp();
    await mkdir(path.join(root, 'src', 'components'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });

    await writeFile(path.join(root, 'src', 'login.ts'), 'export const a = 1;', 'utf8');
    await writeFile(path.join(root, 'src', 'components', 'Button.tsx'), 'export const B = 1;', 'utf8');
    await writeFile(path.join(root, 'README.md'), '# hi', 'utf8');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), '', 'utf8');
    await writeFile(path.join(root, 'dist', 'bundle.js'), '', 'utf8');
    return root;
  }

  it('列出文件（相对路径，正斜杠）', async () => {
    const root = await makeProject();
    const { files } = await listFiles(root);
    const paths = files.map((f) => f.path);

    assert.ok(paths.includes('src/login.ts'));
    assert.ok(paths.includes('src/components/Button.tsx'));
    assert.ok(paths.includes('README.md'));
  });

  it('**跳过 node_modules 和 dist**', async () => {
    const root = await makeProject();
    const paths = (await listFiles(root)).files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith('node_modules')));
    assert.ok(!paths.some((p) => p.startsWith('dist')));
  });

  it('目录不存在时返回空，不抛错', async () => {
    const { files } = await listFiles(path.join(await tmp(), 'nope'));
    assert.deepEqual(files, []);
  });
});

describe('打分', () => {
  it('文件名完全匹配得分最高', () => {
    const a = scoreFile(file('src/login.ts'), 'login.ts');
    assert.ok(a !== null && a >= 900);
  });

  it('不带扩展名也能高分匹配（用户打 @login）', () => {
    const a = scoreFile(file('src/login.ts'), 'login');
    assert.ok(a !== null && a >= 900, `得分 ${a}`);
  });

  it('文件名开头匹配', () => {
    const a = scoreFile(file('src/logger.ts'), 'log');
    assert.ok(a !== null && a >= 900);
  });

  it('路径包含也匹配（分低一些）', () => {
    const a = scoreFile(file('src/components/Button.tsx'), 'components');
    const b = scoreFile(file('src/components/Button.tsx'), 'Button');
    assert.ok(a !== null && b !== null);
    assert.ok(b > a, '文件名匹配应比路径匹配得分高');
  });

  it('**子序列匹配**：lt 能找到 login.ts', () => {
    const a = scoreFile(file('src/login.ts'), 'lt');
    assert.ok(a !== null, 'l...t 应当命中');
  });

  it('完全不相干返回 null', () => {
    assert.equal(scoreFile(file('src/login.ts'), 'xyz'), null);
  });
});

describe('排序', () => {
  const files = [
    file('docs/logging.md'),
    file('src/login.ts'),
    file('src/logger.ts'),
    file('src/components/LoginForm.tsx'),
  ];

  it('登录相关文件排前面', () => {
    const results = searchFiles(files, 'login');
    assert.equal(results[0]?.name, 'login.ts');
  });

  it('代码文件优先于文档', () => {
    const results = searchFiles(files, 'log');
    const firstCode = results.findIndex((f) => f.name.endsWith('.ts') || f.name.endsWith('.tsx'));
    const firstDoc = results.findIndex((f) => f.name.endsWith('.md'));
    assert.ok(firstCode !== -1 && (firstDoc === -1 || firstCode < firstDoc));
  });

  it('限制返回条数', () => {
    const many = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`));
    assert.ok(searchFiles(many, 'f', 10).length <= 10);
  });

  it('空查询返回全部（受 limit 限制）', () => {
    assert.equal(searchFiles(files, '', 2).length, 2);
  });

  it('没有匹配返回空数组', () => {
    assert.deepEqual(searchFiles(files, 'zzzz'), []);
  });
});

describe('注入上下文', () => {
  it('带路径和代码块', () => {
    const text = renderReference('src/login.ts', 'export const a = 1;');
    assert.match(text, /引用文件：src\/login\.ts/);
    assert.match(text, /```/);
    assert.match(text, /export const a = 1;/);
  });

  it('**超大文件被截断**（防止塞爆上下文）', () => {
    const big = 'x'.repeat(MAX_REFERENCE_BYTES + 1000);
    const text = renderReference('big.log', big);
    assert.ok(text.length < big.length, '应当比原文短');
    assert.match(text, /已截断/);
  });

  it('正常大小不截断', () => {
    assert.ok(!renderReference('a.ts', 'x'.repeat(100)).includes('已截断'));
  });
});

describe('从文本里抽引用', () => {
  it('抽出单个引用', () => {
    assert.deepEqual(extractReferences('改一下 @src/login.ts'), ['src/login.ts']);
  });

  it('抽出多个', () => {
    assert.deepEqual(
      extractReferences('对比 @a.ts 和 @b.ts'),
      ['a.ts', 'b.ts'],
    );
  });

  it('没有引用返回空', () => {
    assert.deepEqual(extractReferences('就是一句话'), []);
  });

  it('反斜杠路径统一成正斜杠', () => {
    assert.deepEqual(extractReferences('看 @src\\login.ts'), ['src/login.ts']);
  });
});
