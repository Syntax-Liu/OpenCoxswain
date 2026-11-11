/**
 * 副作用台账测试。
 *
 * 目标：出事时能回答"它到底改了什么"，并且**执行前就有记录**。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { classifySideEffect, sideEffectDeduped, sideEffectKey } from '../security/side-effect.js';
import { SideEffectLedger, describeEffect } from '../security/ledger.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function projectDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-ledger-'));
  temps.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

describe('副作用分类', () => {
  it('写文件', () => {
    const r = classifySideEffect('write_file', { path: 'a.txt' });
    assert.equal(r?.kind, 'fs.write');
    assert.equal(r?.reversible, true, '文件写入可补偿');
  });

  it('命令里的删除归为 fs.delete，而不是笼统的 proc.exec', () => {
    const r = classifySideEffect('run_command', { command: 'rm -rf dist' });
    assert.equal(r?.kind, 'fs.delete');
  });

  it('命令里的外发归为 net.send', () => {
    const r = classifySideEffect('run_command', { command: 'git push origin main' });
    assert.equal(r?.kind, 'net.send');
    assert.equal(r?.reversible, false, '推上去就收不回来');
  });

  it('普通命令是 proc.exec', () => {
    const r = classifySideEffect('run_command', { command: 'pnpm test' });
    assert.equal(r?.kind, 'proc.exec');
    assert.equal(r?.reversible, false);
  });

  it('读类工具没有副作用', () => {
    assert.equal(classifySideEffect('read_file', { path: 'a.txt' }), null);
    assert.equal(classifySideEffect('list_dir', {}), null);
    assert.equal(classifySideEffect('search_files', { query: 'x' }), null);
  });

  it('去重策略：文件类去重，命令不去重', () => {
    assert.equal(sideEffectDeduped('fs.write'), true);
    assert.equal(sideEffectDeduped('fs.delete'), true);
    assert.equal(sideEffectDeduped('net.send'), true);
    assert.equal(sideEffectDeduped('proc.exec'), false, '同一条命令跑两次就是两次副作用');
  });

  it('幂等键：参数顺序不影响结果', () => {
    const a = sideEffectKey('e1', 'write_file', { path: 'a', content: 'x' });
    const b = sideEffectKey('e1', 'write_file', { content: 'x', path: 'a' });
    assert.equal(a, b);
  });

  it('幂等键：不同执行者不同', () => {
    const a = sideEffectKey('e1', 'write_file', { path: 'a' });
    const b = sideEffectKey('e2', 'write_file', { path: 'a' });
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// 台账记录器
// ---------------------------------------------------------------------------

describe('台账记录器', () => {
  function ledger(store: MemoryStore) {
    return new SideEffectLedger({ store, projectId: 'p1', executorId: 'e1' });
  }

  it('执行前落 pending', async () => {
    const store = new MemoryStore();
    const l = ledger(store);
    const pending = await l.begin('write_file', { path: 'a.txt', content: 'x' });

    assert.ok(pending.row);
    assert.equal(pending.row.state, 'pending');
    assert.equal(store.listSideEffects({ executorId: 'e1' }).length, 1);
  });

  it('结算后变 succeeded', async () => {
    const store = new MemoryStore();
    const l = ledger(store);
    const p = await l.begin('write_file', { path: 'a.txt' });
    await l.settle(p.row, 'succeeded');

    const row = store.getSideEffect(p.row!.id);
    assert.equal(row?.state, 'succeeded');
    assert.ok(row?.settledAt);
  });

  it('读类工具不产生记录', async () => {
    const store = new MemoryStore();
    const l = ledger(store);
    const p = await l.begin('read_file', { path: 'a.txt' });
    assert.equal(p.row, null);
    assert.equal(store.listSideEffects({ executorId: 'e1' }).length, 0);
  });

  it('重复写同一文件只记一条（去重命中）', async () => {
    const store = new MemoryStore();
    const l = ledger(store);

    const first = await l.begin('write_file', { path: 'a.txt', content: 'x' });
    assert.equal(first.skipped, false);
    await l.settle(first.row, 'succeeded');

    const second = await l.begin('write_file', { path: 'a.txt', content: 'x' });
    assert.equal(second.skipped, true, '同样的写应当被去重');
    assert.equal(store.listSideEffects({ executorId: 'e1' }).length, 1);
  });

  it('同一条命令跑两次记两条', async () => {
    const store = new MemoryStore();
    const l = ledger(store);

    const a = await l.begin('run_command', { command: 'echo hi' });
    await l.settle(a.row, 'succeeded');
    const b = await l.begin('run_command', { command: 'echo hi' });
    assert.equal(b.skipped, false, '命令不去重');
    assert.equal(store.listSideEffects({ executorId: 'e1' }).length, 2);
  });

  it('可读描述区分状态与不可撤销', async () => {
    const store = new MemoryStore();
    const l = ledger(store);
    const p = await l.begin('run_command', { command: 'git push' });
    await l.settle(p.row, 'rejected', '用户拒绝');

    const text = describeEffect(store.getSideEffect(p.row!.id)!);
    assert.match(text, /对外发送/);
    assert.match(text, /不可撤销/);
    assert.match(text, /被拒绝/);
  });
});

// ---------------------------------------------------------------------------
// 端到端
// ---------------------------------------------------------------------------

describe('端到端：D 干了什么都有记录', () => {
  it('写两个文件 → 台账两条，参数可读', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    let step = 0;
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      step += 1;
      if (step === 1) return { tool: 'write_file', args: { path: 'a.txt', content: 'A' } };
      if (step === 2) return { tool: 'write_file', args: { path: 'b.txt', content: 'B' } };
      return { text: '结论：写了两个文件。' };
    });

    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });
    const spawned = await runtime.spawn(project.id, {
      label: '写两个文件',
      goal: '写 a.txt 和 b.txt',
      writeScope: ['a.txt', 'b.txt'],
    });

    await waitFor(
      () => {
        const e = store.getExecutor(spawned.executor.id);
        return e?.status === 'done' || e?.status === 'failed';
      },
      10000,
    );

    const effects = store.listSideEffects({ executorId: spawned.executor.id });
    assert.equal(effects.length, 2, '两个文件两条记录');
    assert.ok(effects.every((e) => e.kind === 'fs.write'));
    assert.ok(effects.every((e) => e.state === 'succeeded'));
    assert.ok(effects.some((e) => e.target.includes('a.txt')));
    assert.ok(effects.some((e) => e.args.includes('A')), '参数要能看懂');

    // 文件确实写了
    assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'A');

    await runtime.dispose();
  });

  it('被审批拒绝的动作记为 rejected（不是 failed）', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    let step = 0;
    const dangerCommand = process.platform === 'win32' ? 'del victim.txt' : 'rm victim.txt';
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      step += 1;
      if (step === 1) return { tool: 'run_command', args: { command: dangerCommand } };
      return { text: '结论：删除被拒绝，没执行。' };
    });

    // 审批超时自动拒绝 → 动作不该执行
    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 120 });
    const { project } = await runtime.openProject({ rootPath: root });
    const spawn = await runtime.spawn(project.id, {
      label: '想删文件',
      goal: '删 victim.txt',
      writeScope: ['victim.txt'],
    });

    await waitFor(
      () => {
        const e = store.getExecutor(spawn.executor.id);
        return e?.status === 'done' || e?.status === 'failed';
      },
      10000,
    );

    const effects = store.listSideEffects({ executorId: spawn.executor.id });
    assert.equal(effects.length, 1);
    assert.equal(effects[0]?.state, 'rejected', '没执行的动作记为 rejected');
    assert.ok(effects[0]?.note, '要留下拒绝原因');

    await runtime.dispose();
  });

  it('读操作不进台账（避免噪音淹没关键记录）', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    let step = 0;
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      step += 1;
      if (step <= 2) return { tool: 'list_dir', args: { path: '.' } };
      return { text: '结论：看完了。' };
    });

    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });
    const spawn = await runtime.spawn(project.id, {
      label: '只读查看',
      goal: '看看目录',
      writeScope: ['readonly'],
    });

    await waitFor(
      () => {
        const e = store.getExecutor(spawn.executor.id);
        return e?.status === 'done' || e?.status === 'failed';
      },
      10000,
    );

    assert.equal(store.listSideEffects({ executorId: spawn.executor.id }).length, 0);

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
