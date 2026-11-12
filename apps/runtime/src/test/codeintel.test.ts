/**
 * 代码导航测试。
 *
 * 这不是完整的 LSP——是**词法层面的符号查找**。所以测试要同时守住：
 * 1. 常见语言的声明能被正确识别
 * 2. **不误报**（`foo` 不该命中 `foobar`、注释里的不算定义）
 * 3. 找不到时给出有用的说明，而不是空结果
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  countOccurrences,
  findSymbol,
  listSymbols,
  matchDefinition,
  renderSymbolResult,
} from '../codeintel/symbols.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-sym-'));
  temps.push(d);
  return d;
}

describe('定义识别：TypeScript', () => {
  it('函数声明', () => {
    assert.equal(matchDefinition('export function foo(a: number) {', 'foo'), 'function');
    assert.equal(matchDefinition('  function bar() {', 'bar'), 'function');
  });

  it('async 函数', () => {
    assert.equal(matchDefinition('export async function load(id: string) {', 'load'), 'function');
  });

  it('箭头函数常量', () => {
    assert.equal(matchDefinition('const handler = (e) => {', 'handler'), 'function');
  });

  it('类与接口', () => {
    assert.equal(matchDefinition('export class Store {', 'Store'), 'class');
    assert.equal(matchDefinition('export interface Options {', 'Options'), 'interface');
    assert.equal(matchDefinition('type Result = string;', 'Result'), 'interface');
  });

  it('普通常量', () => {
    assert.equal(matchDefinition('const LIMIT = 100;', 'LIMIT'), 'variable');
  });

  it('类方法', () => {
    assert.equal(matchDefinition('  run(args: unknown) {', 'run'), 'function');
    assert.equal(matchDefinition('  async execute() {', 'execute'), 'function');
  });
});

describe('定义识别：其它语言', () => {
  it('Python', () => {
    assert.equal(matchDefinition('def process(items):', 'process'), 'function');
    assert.equal(matchDefinition('class Handler:', 'Handler'), 'class');
  });

  it('Rust', () => {
    assert.equal(matchDefinition('pub fn handle(&self) {', 'handle'), 'function');
    assert.equal(matchDefinition('pub struct Config {', 'Config'), 'class');
  });

  it('Go', () => {
    assert.equal(matchDefinition('func Compute(a int) int {', 'Compute'), 'function');
    assert.equal(matchDefinition('type Point struct {', 'Point'), 'class');
  });
});

describe('不误报', () => {
  it('**调用不是定义**', () => {
    assert.equal(matchDefinition('  foo(1, 2);', 'foo'), null);
    assert.equal(matchDefinition('  return foo(x);', 'foo'), null);
  });

  it('**名字必须完整匹配**（foo 不命中 foobar）', () => {
    assert.equal(matchDefinition('function foobar() {', 'foo'), null);
  });

  it('属性访问不是定义', () => {
    assert.equal(matchDefinition('  obj.foo = 1;', 'foo'), null);
  });

  it('导入语句不算函数定义', () => {
    // import 不该被误判成 function
    assert.notEqual(matchDefinition("import { foo } from './x';", 'foo'), 'function');
  });
});

describe('引用计数', () => {
  it('按词边界统计', () => {
    assert.equal(countOccurrences('foo(foo) + foobar', 'foo'), 2);
  });

  it('没有时返回 0', () => {
    assert.equal(countOccurrences('nothing here', 'foo'), 0);
  });
});

describe('真实目录扫描', () => {
  async function makeProject(): Promise<string> {
    const root = await tmp();
    await mkdir(path.join(root, 'src'), { recursive: true });

    await writeFile(
      path.join(root, 'src', 'math.ts'),
      ['export function add(a: number, b: number) {', '  return a + b;', '}', ''].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(root, 'src', 'use.ts'),
      ['import { add } from "./math";', '', 'const total = add(1, 2);', 'add(3, 4);', ''].join('\n'),
      'utf8',
    );

    // 应该被跳过的目录
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(
      path.join(root, 'node_modules', 'pkg', 'index.ts'),
      'export function add() {}\n',
      'utf8',
    );

    return root;
  }

  it('**找到定义位置**', async () => {
    const root = await makeProject();
    const r = await findSymbol(root, 'add');
    assert.equal(r.definitions.length, 1, '只该有一处定义');
    assert.equal(r.definitions[0]?.file, 'src/math.ts');
    assert.equal(r.definitions[0]?.line, 1);
    assert.equal(r.definitions[0]?.kind, 'function');
  });

  it('**找到所有引用**（排除定义行）', async () => {
    const root = await makeProject();
    const r = await findSymbol(root, 'add');
    const files = r.references.map((x) => x.file);
    assert.ok(files.includes('src/use.ts'));
    assert.ok(
      !r.references.some((x) => x.file === 'src/math.ts'),
      '定义行不该同时算作引用',
    );
  });

  it('**跳过 node_modules**', async () => {
    const root = await makeProject();
    const r = await findSymbol(root, 'add');
    assert.ok(
      !r.definitions.some((d) => d.file.includes('node_modules')),
      '不该扫依赖目录',
    );
  });

  it('符号不存在时返回空并给说明', async () => {
    const root = await makeProject();
    const r = await findSymbol(root, 'doesNotExist');
    assert.equal(r.definitions.length, 0);
    assert.equal(r.references.length, 0);

    const text = renderSymbolResult('doesNotExist', r);
    assert.match(text, /没找到/);
    assert.match(text, /扫描了/);
  });

  it('渲染结果含定义与引用两个区段', async () => {
    const root = await makeProject();
    const text = renderSymbolResult('add', await findSymbol(root, 'add'));
    assert.match(text, /## add 的定义/);
    assert.match(text, /## 引用/);
    assert.match(text, /src\/math\.ts:1/);
  });

  it('**渲染结果如实说明局限**（不假装是语义分析）', async () => {
    const root = await makeProject();
    const text = renderSymbolResult('add', await findSymbol(root, 'add'));
    assert.match(text, /词法层面/);
    assert.match(text, /同名但不同作用域/);
  });
});

describe('列出文件里的符号', () => {
  it('找出函数和常量', async () => {
    const root = await tmp();
    const file = path.join(root, 'demo.ts');
    await writeFile(
      file,
      ['export const LIMIT = 10;', 'export function run() {', '  return LIMIT;', '}', ''].join('\n'),
      'utf8',
    );

    const symbols = await listSymbols(file);
    const kinds = symbols.map((s) => s.kind);
    assert.ok(kinds.includes('variable'));
    assert.ok(kinds.includes('function'));
  });

  it('注释行被跳过', async () => {
    const root = await tmp();
    const file = path.join(root, 'demo.ts');
    await writeFile(file, ['// function fake() {', '/* class Fake {} */', 'let real = 1;', ''].join('\n'), 'utf8');

    const symbols = await listSymbols(file);
    assert.ok(!symbols.some((s) => s.preview.includes('fake')));
    assert.ok(symbols.some((s) => s.preview.includes('real')));
  });

  it('**块内局部变量不算文件级符号**（for 循环不该被列出来）', async () => {
    const root = await tmp();
    const file = path.join(root, 'demo.ts');
    await writeFile(
      file,
      [
        'export function top() {',
        '  for (const item of list) {',
        '    const temp = item;',
        '  }',
        '  if (x) {',
        '    const inner = 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const symbols = await listSymbols(file);
    const previews = symbols.map((s) => s.preview).join('\n');
    assert.ok(!previews.includes('for (const'), 'for 里的声明不该出现');
    assert.ok(!previews.includes('const inner'), '深层缩进的声明不该出现');
    assert.ok(previews.includes('export function top'), '文件级函数该出现');
  });
});
