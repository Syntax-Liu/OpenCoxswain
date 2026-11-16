import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { verify } from '../acceptance/verify.js';
import type { Criterion } from '../acceptance/criteria.js';

/**
 * 只读任务不该被 `diff` 判失败。
 *
 * ## 2026-11-16 用户实测
 *
 * 派一个只读 Agent 数 .md 文件，Agent 干完了，系统复核报：
 *
 *     系统复核未通过：没有改动任何文件（只读任务）（命令失败（退出码 128））
 *
 * 于是判失败，用户以为 Agent 没干活。
 *
 * **只读任务本来就不许改文件。** 拿"必须有改动"去验它，
 * 等于做得越对越通不过。
 *
 * ## 但要区分两种情况
 *
 *   writeScope === ['readonly']  → 用户要求只读，diff 不适用
 *   writeScope 有真实路径        → 用户想写，只是权限降级了，
 *                                  仍然该因为"什么都没改"判失败
 *
 * 第二种正是"谎报完成"的典型特征，不能因为权限不够就放过。
 */

const dirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ocx-ro-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'base');
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

const diffCriterion: Criterion = { id: 'd', type: 'diff', desc: '有改动' };

const opts = (rootPath: string, readonlyTask?: boolean) => ({
  rootPath,
  criteria: [diffCriterion],
  policy: 'auto' as const,
  approve: async () => ({ approved: true, reason: '测试放行' }),
  ...(readonlyTask ? { readonlyTask: true } : {}),
});

describe('**只读任务：diff 不适用**', () => {
  it('只读任务没改文件 → 通过（不是失败）', async () => {
    const dir = makeRepo();
    const r = await verify(opts(dir, true));
    assert.equal(r.results[0]?.verdict, 'passed', `不该判失败：${r.results[0]?.note}`);
    assert.match(r.results[0]?.note ?? '', /只读/, '要说清为什么通不过这条标准');
  });
});

describe('**权限降级的写任务仍然判失败**', () => {
  it('想写却没改 → 失败（这是谎报的典型特征）', async () => {
    const dir = makeRepo();
    const r = await verify(opts(dir, false));
    assert.equal(r.results[0]?.verdict, 'failed', '权限不够不是放过"什么都没改"的理由');
  });
});
