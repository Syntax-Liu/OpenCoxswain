/**
 * 危险动作审批测试。
 *
 * 最重要的一条断言是：**没批准则动作根本没发生**。
 * 不是"执行了再撤销"——删掉的文件不会自己回来。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { classifyDanger, categoryLabel } from '../security/classify.js';
import { approveAction, rejectAction } from '../security/approval.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-approve-'));
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 分类：既要拦得住，也不能误伤
// ---------------------------------------------------------------------------

describe('危险动作识别', () => {
  const cmd = (command: string) => classifyDanger('run_command', { command });

  it('识别删除', () => {
    assert.equal(cmd('rm -rf dist')?.category, 'delete');
    assert.equal(cmd('rmdir /s build')?.category, 'delete');
    assert.equal(cmd('Remove-Item -Recurse node_modules')?.category, 'delete');
    assert.equal(cmd('git clean -fdx')?.category, 'delete');
  });

  it('识别推送', () => {
    assert.equal(cmd('git push origin main')?.category, 'push');
    assert.equal(cmd('git push --force')?.category, 'push');
  });

  it('识别发布与外发', () => {
    assert.equal(cmd('npm publish')?.category, 'publish');
    assert.equal(cmd('gh release create v1.0')?.category, 'publish');
    assert.equal(cmd('git send-email --to a@b.com')?.category, 'external_send');
    assert.equal(cmd('curl -X POST https://api.example.com/hook')?.category, 'external_send');
  });

  it('git push --dry-run 不拦（它不产生远端副作用）', () => {
    assert.equal(cmd('git push --dry-run origin main'), null);
  });

  it('**不误伤**常见命令（回归：旧实现把 grep pay 当付款）', () => {
    for (const safe of [
      'grep -r "pay" src/',
      'Get-ChildItem payments',
      'node checkout_payment.test.js',
      'cat pay.md',
      'git status',
      'git log --oneline -5',
      'pnpm test',
      'npm run build',
      'Get-Content README.md',
      'echo "hello"',
    ]) {
      assert.equal(cmd(safe), null, `不该拦：${safe}`);
    }
  });

  it('只看命令字段，不看文件内容', () => {
    // 写一个含 "git push" 字样的文件不是危险动作
    assert.equal(
      classifyDanger('write_file', { path: 'doc.md', content: '执行 git push 前请确认' }),
      null,
    );
  });

  it('类别有中文标签', () => {
    assert.equal(categoryLabel('delete'), '删除');
    assert.equal(categoryLabel('external_send'), '对外发送');
  });
});

// ---------------------------------------------------------------------------
// 闸门行为
// ---------------------------------------------------------------------------

describe('审批闸门', () => {
  it('批准后才允许执行', async () => {
    const store = new MemoryStore();
    const root = await projectDir();
    const { project } = await new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    }).openProject({ rootPath: root });

    // 造一条待审批
    const gate = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    void gate;

    let waited = false;
    const pending = (async () => {
      const { requestApproval } = await import('../security/approval.js');
      waited = true;
      return requestApproval(
        { store, projectId: project.id, executorId: 'exe_1', pollMs: 10, timeoutMs: 5000 },
        'run_command',
        { command: 'rm -rf x' },
        classifyDanger('run_command', { command: 'rm -rf x' })!,
      );
    })();

    // 等审批记录出现
    await waitFor(() => store.listApprovals({ status: ['pending'] }).length > 0, 2000);
    assert.ok(waited);

    const approval = store.listApprovals({ status: ['pending'] })[0]!;
    assert.equal(approval.category, 'delete');
    assert.match(approval.evidence, /rm -rf/);

    await approveAction(store, approval.id, '确认这是临时目录');
    const decision = await pending;

    assert.equal(decision.approved, true);
    assert.match(decision.reason, /临时目录/);
  });

  it('拒绝后动作不执行，并返回可读原因', async () => {
    const store = new MemoryStore();
    const root = await projectDir();
    const { project } = await new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    }).openProject({ rootPath: root });

    const { requestApproval } = await import('../security/approval.js');
    const pending = requestApproval(
      { store, projectId: project.id, executorId: 'exe_1', pollMs: 10, timeoutMs: 5000 },
      'run_command',
      { command: 'git push' },
      classifyDanger('run_command', { command: 'git push' })!,
    );

    await waitFor(() => store.listApprovals({ status: ['pending'] }).length > 0, 2000);
    const approval = store.listApprovals({ status: ['pending'] })[0]!;
    await rejectAction(store, approval.id, '还没准备好发布');

    const decision = await pending;
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /还没准备好/);
  });

  it('超时自动拒绝（不会永远挂起）', async () => {
    const store = new MemoryStore();
    const root = await projectDir();
    const { project } = await new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    }).openProject({ rootPath: root });

    const { requestApproval } = await import('../security/approval.js');
    const decision = await requestApproval(
      { store, projectId: project.id, executorId: 'exe_1', pollMs: 10, timeoutMs: 60 },
      'run_command',
      { command: 'npm publish' },
      classifyDanger('run_command', { command: 'npm publish' })!,
    );

    assert.equal(decision.approved, false);
    assert.match(decision.reason, /超时/);
    // 记录状态也要落成 expired
    const rows = store.listApprovals({ projectId: project.id });
    assert.equal(rows[0]?.status, 'expired');
  });

  it('已决定的审批不能重复处理', async () => {
    const store = new MemoryStore();
    const root = await projectDir();
    const { project } = await new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    }).openProject({ rootPath: root });

    const { requestApproval } = await import('../security/approval.js');
    void requestApproval(
      { store, projectId: project.id, executorId: 'exe_1', pollMs: 10, timeoutMs: 300 },
      'run_command',
      { command: 'rm -rf y' },
      classifyDanger('run_command', { command: 'rm -rf y' })!,
    );
    await waitFor(() => store.listApprovals({ status: ['pending'] }).length > 0, 2000);
    const id = store.listApprovals({ status: ['pending'] })[0]!.id;

    assert.equal((await approveAction(store, id)).ok, true);
    const second = await rejectAction(store, id);
    assert.equal(second.ok, false);
    assert.match(second.message, /已是 approved/);
  });
});

// ---------------------------------------------------------------------------
// 端到端：没批准则文件仍在
// ---------------------------------------------------------------------------

describe('端到端：未批准的动作真的没发生', () => {
  it('D 尝试删除文件 → 被拦下 → 文件仍在', async () => {
    const root = await projectDir();
    const victim = path.join(root, 'important.txt');
    await writeFile(victim, '不可丢失的数据', 'utf8');

    const store = new MemoryStore();
    let phase = 0;
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      phase += 1;
      if (phase === 1) {
        return { tool: 'run_command', args: { command: 'Remove-Item important.txt' } };
      }
      return { text: '结论：删除被拒绝，文件保留。' };
    });

    // 没人批准 → 用很短的超时让它自动拒绝
    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 150 });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, { label: '删文件的', goal: '删掉 important.txt' });

    // 等审批出现
    await waitFor(
      () => store.listApprovals({ projectId: project.id }).length > 0,
      5000,
    );
    const approval = store.listApprovals({ projectId: project.id })[0]!;
    assert.equal(approval.category, 'delete');
    assert.match(approval.evidence, /Remove-Item/);

    // 等Agent结束
    await waitFor(
      () => {
        const e = store.listExecutors({ projectId: project.id })[0];
        return e !== undefined && (e.status === 'done' || e.status === 'failed');
      },
      8000,
    );

    // **关键断言：文件还在**
    const content = await readFile(victim, 'utf8');
    assert.equal(content, '不可丢失的数据', '未批准的动作绝不能被执行');

    // 用户被通知了
    const reports = store.listReports({ projectId: project.id, needsUser: true });
    assert.ok(reports.some((r) => r.body.includes('危险动作') || r.body.includes('delete')));

    await runtime.dispose();
  });

  it('批准后动作真的执行', async () => {
    const root = await projectDir();
    const victim = path.join(root, 'temp.txt');
    await writeFile(victim, 'temp', 'utf8');

    const store = new MemoryStore();
    let phase = 0;
    // 用 cmd 原生能跑的 `del`，而不是只在 PowerShell 里有的 `Remove-Item`。
    // （run_command 在 Windows 上跑的是 cmd.exe，这点工具描述里已写明。）
    const dangerCommand = process.platform === 'win32' ? 'del temp.txt' : 'rm temp.txt';
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      phase += 1;
      if (phase === 1) {
        return { tool: 'run_command', args: { command: dangerCommand } };
      }
      return { text: '结论：已删除 temp.txt。' };
    });

    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 10000 });
    const { project } = await runtime.openProject({ rootPath: root });

    void runtime.spawn(project.id, { label: '删临时文件', goal: '删掉 temp.txt' });

    await waitFor(() => store.listApprovals({ status: ['pending'] }).length > 0, 5000);
    const approval = store.listApprovals({ status: ['pending'] })[0]!;
    await approveAction(store, approval.id, '确实是临时文件');

    await waitFor(
      () => {
        const e = store.listExecutors({ projectId: project.id })[0];
        return e !== undefined && (e.status === 'done' || e.status === 'failed');
      },
      10000,
    );

    // 文件应当已被删掉
    await assert.rejects(() => readFile(victim, 'utf8'), '批准后动作应当执行');

    await runtime.dispose();
  });

  it('只读任务根本不会触发审批（它自己先被拦了）', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    let phase = 0;
    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      phase += 1;
      if (phase === 1) {
        return { tool: 'run_command', args: { command: 'rm -rf build' } };
      }
      return { text: '结论：只读任务不能删除。' };
    });

    const runtime = new Orchestrator({ store, llm, approvalTimeoutMs: 200 });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, {
      label: '只读的',
      goal: '看看 build 目录',
      writeScope: ['readonly'],
    });

    await waitFor(
      () => {
        const e = store.listExecutors({ projectId: project.id })[0];
        return e !== undefined && (e.status === 'done' || e.status === 'failed');
      },
      8000,
    );

    // 只读拦截发生在审批之前，所以不该产生审批记录
    assert.equal(store.listApprovals({ projectId: project.id }).length, 0);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}
