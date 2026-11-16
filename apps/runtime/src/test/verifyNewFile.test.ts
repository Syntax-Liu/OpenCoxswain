import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { verify } from '../acceptance/verify.js';
import type { Criterion } from '../acceptance/criteria.js';

/**
 * `diff` 标准必须能看到**新建的文件**。
 *
 * ## 2026-11-16 用户实测踩到的
 *
 * 测试提示词：
 *
 * > 在项目根目录下面创建一个 hello.cpp，然后内容用 C++ 写一个输出
 * > "Hello, I am OpenCoxswain."，不需要编译
 *
 * Agent 写好了，人工核验也没问题，但系统复核报：
 *
 * > Agent 自称写好了，但系统复核发现工作区没有任何改动
 *
 * 于是判失败，Assistant 还说要重派（也没派）。
 *
 * ## 原因
 *
 * `git diff` **只比已跟踪的文件**。新建的文件是 untracked，
 * 在 diff 里根本不存在。
 *
 * 这不是边缘情况——「新建一个文件」是最常见的任务之一。
 */

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocx-verify-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

const diffCriterion: Criterion = { id: 'd1', type: 'diff', desc: '工作区有改动' };

const opts = (rootPath: string) => ({
  rootPath,
  criteria: [diffCriterion],
  policy: 'auto' as const,
  approve: async () => ({ approved: true, reason: '测试放行' }),
});

describe('**新建文件必须算改动**', () => {
  it('只新建一个文件 → 通过（不是"什么都没改"）', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'hello.cpp'), '#include <iostream>\nint main(){}\n');

    const result = await verify(opts(dir));
    const r = result.results[0];
    assert.equal(r?.verdict, 'passed', `不该判失败：${r?.note}`);
    assert.match(r?.note ?? '', /新建/, '应该说清是新建');
    assert.match(r?.note ?? '', /hello\.cpp/, '应该点名是哪个文件');
  });

  it('新建多个文件 → 全部计入', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a.cpp'), 'int a;\n');
    writeFileSync(join(dir, 'b.cpp'), 'int b;\n');

    const result = await verify(opts(dir));
    assert.equal(result.results[0]?.verdict, 'passed');
    assert.match(result.results[0]?.note ?? '', /2 个/);
  });

  it('**真的什么都没改 → 仍然判失败**（不能放宽）', async () => {
    const dir = makeRepo();
    const result = await verify(opts(dir));
    assert.equal(result.results[0]?.verdict, 'failed', '没改动就该失败，不能因为这个修复放宽');
    assert.match(result.results[0]?.note ?? '', /没有任何改动/);
  });
});

describe('原有行为不受影响', () => {
  it('改已跟踪的文件 → 通过', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# repo\n\n加了内容\n');

    const result = await verify(opts(dir));
    assert.equal(result.results[0]?.verdict, 'passed');
    assert.match(result.results[0]?.note ?? '', /改了 1 个文件/);
  });

  it('改文件 + 新建文件 → 两个都说', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'README.md'), '# repo\n\n改了\n');
    writeFileSync(join(dir, 'new.cpp'), 'int x;\n');

    const result = await verify(opts(dir));
    assert.equal(result.results[0]?.verdict, 'passed');
    assert.match(result.results[0]?.note ?? '', /改了 1 个文件/);
    assert.match(result.results[0]?.note ?? '', /另新建 1 个文件/);
  });
});
