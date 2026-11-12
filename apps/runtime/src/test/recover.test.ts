/**
 * 重启恢复测试：「关掉软件再打开，C 还记得之前的事」。
 *
 * 这是用户明确要求的 D5，也是持久化唯一真正要证明的事。
 * 用**两个独立的 Orchestrator 实例**模拟两次进程启动，中间共享同一个 SQLite 文件。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { SqliteStore } from '../store/sqlite.js';
import { EMPTY_METRICS } from '../cost/metrics.js';
import { MockLlmClient, isAssistantTurn, isExecutorTurn, isSettlementNotice } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-recover-'));
  temps.push(dir);
  return path.join(dir, 'state.db');
}

/** 记录 C 每轮看到的完整历史，用来断言"上下文真的还在"。 */
function makeSpyLlm(seen: string[][]) {
  return new MockLlmClient((request) => {
    const system = request.messages.find((m) => m.role === 'system');
    if (isExecutorTurn(request)) {
      return {
        text: '结论：做完了。\n### 做了什么\n无\n### 验证了什么\n未验证\n### 需要用户决定什么\n无',
      };
    }
    if (isSettlementNotice(request)) return { text: '收到结算，已汇报。' };
    if (
      typeof system?.content === 'string' &&
      system.content.startsWith('你是这个项目的「Assistant」')
    ) {
      seen.push(
        request.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => String(m.content)),
      );
      return { text: '好的，我记住了。' };
    }
    return { text: 'ok' };
  });
}

describe('关掉软件后 C 完整恢复（D5）', () => {
  it('第二次启动时 C 能带着上一次的对话继续', async () => {
    const file = await dbPath();
    const seenFirst: string[][] = [];
    const seenSecond: string[][] = [];

    // ---------- 第一次运行 ----------
    const store1 = new SqliteStore({ file });
    const rt1 = new Orchestrator({ store: store1, llm: makeSpyLlm(seenFirst) });
    const opened1 = await rt1.openProject({ rootPath: 'D:/work/app', name: 'demo' });

    await rt1.userSays(opened1.project.id, '我的项目使用 TypeScript 和 pnpm');
    await waitFor(() => seenFirst.length >= 1, 5000);
    await waitForIdle(rt1, opened1.project.id, 3000);
    await rt1.dispose();

    // ---------- 第二次运行（新进程、新实例、同一个库） ----------
    const store2 = new SqliteStore({ file });
    const rt2 = new Orchestrator({ store: store2, llm: makeSpyLlm(seenSecond) });

    const recovery = await rt2.recover();
    assert.equal(recovery.recoveredProjects.length, 1);
    assert.equal(recovery.recoveredProjects[0]!.assistantSessionId, opened1.project.assistantSessionId);

    // 同一路径重新打开 → 必须是同一个项目与同一个 C
    const opened2 = await rt2.openProject({ rootPath: 'D:/work/app' });
    assert.equal(opened2.project.id, opened1.project.id, '项目必须复用');
    assert.equal(
      opened2.project.assistantSessionId,
      opened1.project.assistantSessionId,
      'C 的会话必须复用',
    );

    await rt2.userSays(opened2.project.id, '我刚才说用什么工具链？');
    await waitFor(() => seenSecond.length >= 1, 5000);

    // 关键断言：第二次的请求里必须包含第一次的对话
    const context = seenSecond[0]!.join('\n');
    assert.match(context, /我的项目使用 TypeScript 和 pnpm/, '上一次的对话必须还在上下文里');
    assert.match(context, /我刚才说用什么工具链/, '这一次的消息也要在');

    await rt2.dispose();
  });

  it('上次被中断的执行者被如实标记为失败，而不是假装还在跑', async () => {
    const file = await dbPath();

    // 第一次运行：留一个 running 状态的执行者（模拟进程被强杀）
    const store1 = new SqliteStore({ file });
    const rt1 = new Orchestrator({ store: store1, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const opened = await rt1.openProject({ rootPath: 'D:/work/x' });
    await store1.putExecutor({
      id: 'exe_stuck',
      projectId: opened.project.id,
      sessionId: 'd_stuck',
      label: '被中断的',
      goal: 'g',
      access: 'readwrite',
      writeScope: ['src'],
      status: 'running',
      summary: null,
      blockedReason: null,
      metrics: EMPTY_METRICS,
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: null,
    });
    // 注意：这里不调用 recover/dispose —— 模拟进程被直接杀掉
    await store1.close();

    // 第二次运行
    const store2 = new SqliteStore({ file });
    const rt2 = new Orchestrator({ store: store2, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const recovery = await rt2.recover();

    assert.equal(recovery.interruptedExecutors.length, 1);
    const stuck = store2.getExecutor('exe_stuck');
    assert.equal(stuck?.status, 'failed');
    assert.match(stuck?.blockedReason ?? '', /上次执行被中断/);
    assert.ok(stuck?.endedAt, '必须有结束时间');

    // 不能被悄悄放回队列自动重跑
    assert.equal(
      store2.listExecutors({ projectId: opened.project.id, status: ['running', 'starting'] }).length,
      0,
    );

    await rt2.dispose();
  });

  it('汇报历史跨重启保留（C 不在场时落库的事实不会丢）', async () => {
    const file = await dbPath();

    const store1 = new SqliteStore({ file });
    const rt1 = new Orchestrator({ store: store1, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const opened = await rt1.openProject({ rootPath: 'D:/work/y' });
    await store1.putReport({
      id: 'rpt_1',
      projectId: opened.project.id,
      executorId: null,
      kind: 'done',
      body: '上次的汇报内容',
      needsUser: false,
      at: Date.now(),
      ackedAt: null,
    });
    await rt1.dispose();

    const store2 = new SqliteStore({ file });
    const rt2 = new Orchestrator({ store: store2, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    await rt2.recover();
    assert.equal(store2.listReports({ projectId: opened.project.id }).length, 1);
    await rt2.dispose();
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

async function waitForIdle(
  runtime: Orchestrator,
  projectId: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(() => !runtime.getAssistant(projectId)?.isRunning, timeoutMs);
}
