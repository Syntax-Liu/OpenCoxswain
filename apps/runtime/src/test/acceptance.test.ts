/**
 * 验收测试：**D 说完成不等于完成**。
 *
 * 最重要的一条：D 声称完成但实际什么都没改 → 系统复核判失败。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  combineVerdicts,
  needsHumanReview,
  parseCriteria,
  type CriterionResult,
} from '../acceptance/criteria.js';
import { verify } from '../acceptance/verify.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-accept-'));
  temps.push(d);
  return d;
}

const allowAll = async () => ({ approved: true, reason: 'ok' });

// ---------------------------------------------------------------------------
// 验收标准解析
// ---------------------------------------------------------------------------

describe('验收标准解析', () => {
  it('解析合法标准', () => {
    const list = parseCriteria([
      { id: 'build', desc: '编译通过', type: 'command', check: 'pnpm typecheck' },
      { id: 'look', desc: '人看一眼', type: 'human' },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.check, 'pnpm typecheck');
  });

  it('command 类型缺 check 直接拒绝（不静默忽略）', () => {
    assert.throws(
      () => parseCriteria([{ id: 'x', desc: 'y', type: 'command' }]),
      /必须提供 check/,
    );
  });

  it('非法 type 拒绝', () => {
    assert.throws(() => parseCriteria([{ id: 'x', desc: 'y', type: 'vibes' }]), /type 非法/);
  });

  it('缺 desc 拒绝（要说清验什么）', () => {
    assert.throws(() => parseCriteria([{ id: 'x', type: 'human' }]), /缺少 desc/);
  });

  it('id 重复拒绝', () => {
    assert.throws(
      () =>
        parseCriteria([
          { id: 'a', desc: '1', type: 'human' },
          { id: 'a', desc: '2', type: 'human' },
        ]),
      /重复/,
    );
  });
});

describe('结论汇总与策略', () => {
  const make = (verdict: 'passed' | 'failed' | 'unverified'): CriterionResult => ({
    criterion: { id: 'x', desc: 'x', type: 'human' },
    verdict,
    note: '',
  });

  it('任一失败 → failed', () => {
    assert.equal(combineVerdicts([make('passed'), make('failed')]), 'failed');
  });

  it('全通过 → passed', () => {
    assert.equal(combineVerdicts([make('passed'), make('passed')]), 'passed');
  });

  it('有未验 → unverified', () => {
    assert.equal(combineVerdicts([make('passed'), make('unverified')]), 'unverified');
  });

  it('unverified_only 策略：只把未验的交给人', () => {
    assert.equal(needsHumanReview('unverified_only', [make('passed')]), false);
    assert.equal(needsHumanReview('unverified_only', [make('unverified')]), true);
  });

  it('always_human 策略：一律交给人', () => {
    assert.equal(needsHumanReview('always_human', [make('passed')]), true);
  });
});

// ---------------------------------------------------------------------------
// 系统独立复核
// ---------------------------------------------------------------------------

describe('系统独立复核', () => {
  it('command 通过 → passed', async () => {
    const root = await dir();
    const result = await verify({
      rootPath: root,
      criteria: [{ id: 'ok', desc: '必然成功的命令', type: 'command', check: 'echo hello' }],
      policy: 'unverified_only',
      approve: allowAll,
    });
    assert.equal(result.verdict, 'passed');
    assert.match(result.results[0]?.output ?? '', /hello/);
  });

  it('command 失败 → failed（不看 D 怎么说）', async () => {
    const root = await dir();
    const result = await verify({
      rootPath: root,
      criteria: [{ id: 'bad', desc: '必然失败的命令', type: 'command', check: 'exit 1' }],
      policy: 'unverified_only',
      approve: allowAll,
    });
    assert.equal(result.verdict, 'failed');
    assert.equal(result.needsHuman, false, '失败不允许人工覆盖');
  });

  it('复核命令被审批拒绝 → failed 而不是放行', async () => {
    const root = await dir();
    const result = await verify({
      rootPath: root,
      criteria: [{ id: 'rm', desc: '危险的复核命令', type: 'command', check: 'echo x' }],
      policy: 'unverified_only',
      approve: async () => ({ approved: false, reason: '用户拒绝' }),
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.results[0]?.note ?? '', /未获批准/);
  });

  it('human 类标准 → unverified，需要人看', async () => {
    const root = await dir();
    const result = await verify({
      rootPath: root,
      criteria: [{ id: 'look', desc: '人看一眼', type: 'human' }],
      policy: 'unverified_only',
      approve: allowAll,
    });
    assert.equal(result.verdict, 'unverified');
    assert.equal(result.needsHuman, true);
  });
});

// ---------------------------------------------------------------------------
// 端到端：声称完成但什么都没改
// ---------------------------------------------------------------------------

describe('端到端：D 声称完成但实际没做', () => {
  it('diff 标准检出「工作区没有任何改动」，任务被判失败', async () => {
    const root = await dir();

    // 初始化一个 git 仓库（diff 验收需要它）
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(exec);
    await run('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
    await writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
    await run('git add -A && git commit -q -m init', { cwd: root });

    const store = new MemoryStore();
    // D 什么都没做，直接汇报"已完成"
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      return { text: '结论：已完成，一切都改好了。' };
    });

    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 5000 });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, {
      label: '假装干活的',
      goal: '改点东西',
      writeScope: ['readonly'],
      criteria: [{ id: 'diff', desc: '确实改了文件', type: 'diff' }],
    });

    await waitFor(() => {
      const e = store.listExecutors({ projectId: project.id })[0];
      return e !== undefined && (e.status === 'done' || e.status === 'failed');
    }, 15000);

    const row = store.listExecutors({ projectId: project.id })[0]!;
    assert.equal(row.status, 'failed', 'D 说完成但没改动，必须判失败');
    assert.match(row.blockedReason ?? '', /系统复核未通过/);
    assert.match(row.blockedReason ?? '', /没有任何改动/);
    assert.equal(row.acceptance?.verdict, 'failed');

    await runtime.dispose();
  });

  it('D 确实改了文件 → diff 标准通过', async () => {
    const root = await dir();
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(exec);
    await run('git init -q && git config user.email t@t && git config user.name t', { cwd: root });
    await writeFile(path.join(root, 'a.txt'), 'base', 'utf8');
    await run('git add -A && git commit -q -m init', { cwd: root });

    const store = new MemoryStore();
    let phase = 0;
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      phase += 1;
      if (phase === 1) {
        return { tool: 'write_file', args: { path: 'a.txt', content: 'changed' } };
      }
      return { text: '结论：已把 a.txt 改成 changed。' };
    });

    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 5000 });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, {
      label: '真干活的',
      goal: '改 a.txt',
      writeScope: ['a.txt'],
      criteria: [{ id: 'diff', desc: '确实改了文件', type: 'diff' }],
    });

    await waitFor(() => {
      const e = store.listExecutors({ projectId: project.id })[0];
      return e !== undefined && (e.status === 'done' || e.status === 'failed');
    }, 15000);

    const row = store.listExecutors({ projectId: project.id })[0]!;
    assert.equal(row.status, 'done', `应当通过，实际：${row.blockedReason}`);
    assert.equal(row.acceptance?.verdict, 'passed');

    await runtime.dispose();
  });

  it('没声明验收标准时 acceptance 为 null（不伪装成通过）', async () => {
    const root = await dir();
    const store = new MemoryStore();
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      return { text: '结论：做完了。' };
    });
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, {
      label: '无标准',
      goal: '随便做点',
      writeScope: ['readonly'],
    });

    await waitFor(() => {
      const e = store.listExecutors({ projectId: project.id })[0];
      return e !== undefined && (e.status === 'done' || e.status === 'failed');
    }, 10000);

    const row = store.listExecutors({ projectId: project.id })[0]!;
    assert.equal(row.acceptance, null, '没有标准就是没有复核，不能说通过');

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}
