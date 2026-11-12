/**
 * General Manager（Supervisor）的跨项目能力测试。
 *
 * B 存在的理由是**做 Project Manager（Assistant）结构上做不到的事**：
 * Assistant 只看得到自己那个项目，B 看得到全部。
 *
 * 最重要的一条：**跨项目写冲突必须被拦住**。
 * 两个项目同时改同一个文件会互相覆盖，而两边台账都显示"成功"。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  describeConflict,
  findCrossProjectConflict,
  type AgentClaim,
} from '../global/cross-project.js';
import { buildGlobalOverview, prioritize, describeOverview } from '../global/overview.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-gm-'));
  temps.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 跨项目冲突判定
// ---------------------------------------------------------------------------

describe('跨项目写冲突', () => {
  const claim = (over: Partial<AgentClaim>): AgentClaim => ({
    projectId: 'p1',
    projectRoot: 'D:/proj-a',
    agentId: 'a1',
    label: 'A 的执行者',
    writeScope: ['src'],
    readonly: false,
    ...over,
  });

  it('**两个项目写同一个绝对路径 → 冲突**', () => {
    const mine = claim({ projectId: 'p1', projectRoot: 'D:/shared-lib', writeScope: ['utils'] });
    const other = claim({
      projectId: 'p2',
      projectRoot: 'D:/shared-lib',
      agentId: 'a2',
      writeScope: ['utils/strings.ts'],
    });
    const conflict = findCrossProjectConflict(mine, [other]);
    assert.ok(conflict, '应当检测到冲突');
    assert.match(conflict!.overlap, /shared-lib\/utils/);
  });

  it('**不同项目各自的 src/ 不是冲突**（这是最常见的误判）', () => {
    const a = claim({ projectId: 'p1', projectRoot: 'D:/proj-a', writeScope: ['src'] });
    const b = claim({ projectId: 'p2', projectRoot: 'D:/proj-b', agentId: 'a2', writeScope: ['src'] });
    assert.equal(findCrossProjectConflict(a, [b]), null, '两个项目各改各的 src，不该报冲突');
  });

  it('同项目交给 Gate 处理，这里不管', () => {
    const a = claim({ projectId: 'p1', agentId: 'a1' });
    const b = claim({ projectId: 'p1', agentId: 'a2', writeScope: ['src/util'] });
    assert.equal(findCrossProjectConflict(a, [b]), null);
  });

  it('只读的 Agent 不参与冲突', () => {
    const a = claim({ projectId: 'p1', readonly: true });
    const b = claim({ projectId: 'p2', projectRoot: 'D:/proj-a', agentId: 'a2' });
    assert.equal(findCrossProjectConflict(a, [b]), null);
  });

  it('空写域表示整个项目，会和别人的项目根冲突', () => {
    const a = claim({ projectId: 'p1', projectRoot: 'D:/shared', writeScope: [] });
    const b = claim({ projectId: 'p2', projectRoot: 'D:/shared', agentId: 'a2', writeScope: ['x'] });
    assert.ok(findCrossProjectConflict(a, [b]));
  });

  it('冲突描述说清后果', () => {
    const text = describeConflict({
      withProjectId: 'p2',
      withAgentId: 'a2',
      withLabel: 'Supervisor 的执行者',
      overlap: 'd:/shared/utils',
    });
    assert.match(text, /Supervisor 的执行者/);
    assert.match(text, /互相覆盖/);
  });
});

// ---------------------------------------------------------------------------
// 全局视图
// ---------------------------------------------------------------------------

describe('全局视图', () => {
  it('汇总所有项目的状态', async () => {
    const store = new MemoryStore();
    const root1 = await tmp();
    const root2 = await tmp();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });

    const { project: p1 } = await runtime.openProject({ rootPath: root1, name: '项目一' });
    await runtime.openProject({ rootPath: root2, name: '项目二' });

    // 给项目一造一条待决策
    await store.putReport({
      id: 'r1',
      projectId: p1.id,
      executorId: null,
      kind: 'blocked',
      body: '需要你决定',
      needsUser: true,
      at: Date.now(),
      ackedAt: null,
    });

    const overview = buildGlobalOverview(store);
    assert.equal(overview.projects.length, 2);

    const one = overview.projects.find((p) => p.name === '项目一')!;
    assert.equal(one.state, 'blocked', '有待决策就是 blocked');
    assert.equal(one.needsUser, 1);

    const two = overview.projects.find((p) => p.name === '项目二')!;
    assert.equal(two.state, 'idle');

    assert.equal(overview.totalNeedsUser, 1);

    await runtime.dispose();
  });

  it('没有项目时给可读提示', () => {
    const overview = buildGlobalOverview(new MemoryStore());
    assert.match(describeOverview(overview), /还没有打开任何项目/);
  });

  it('优先级：有危险动作待审批的排最前', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const r1 = await tmp();
    const r2 = await tmp();
    const { project: p1 } = await runtime.openProject({ rootPath: r1, name: '只有汇报' });
    const { project: p2 } = await runtime.openProject({ rootPath: r2, name: '有待审批' });

    await store.putReport({
      id: 'r1',
      projectId: p1.id,
      executorId: null,
      kind: 'blocked',
      body: 'x',
      needsUser: true,
      at: Date.now(),
      ackedAt: null,
    });
    await store.putApproval({
      id: 'ap1',
      projectId: p2.id,
      executorId: 'e1',
      category: 'delete',
      evidence: 'rm -rf',
      why: '测试',
      tool: 'run_command',
      args: '{}',
      status: 'pending',
      decidedReason: null,
      createdAt: Date.now(),
      decidedAt: null,
      expiresAt: Date.now() + 60000,
    });

    const order = prioritize(buildGlobalOverview(store));
    assert.equal(order[0]?.name, '有待审批', '待审批比待汇报更紧急');

    await runtime.dispose();
  });

  it('全局描述会列出在等的项目', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const { project } = await runtime.openProject({ rootPath: await tmp(), name: '待办项目' });

    await store.putReport({
      id: 'r1',
      projectId: project.id,
      executorId: null,
      kind: 'blocked',
      body: 'x',
      needsUser: true,
      at: Date.now(),
      ackedAt: null,
    });

    const text = describeOverview(buildGlobalOverview(store));
    assert.match(text, /待办项目/);
    assert.match(text, /等你/);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// 端到端：派活时拦截跨项目冲突
// ---------------------------------------------------------------------------

describe('端到端：跨项目冲突真的会拦住派活', () => {
  it('**两个项目写同一份共享文件 → 拒绝派活**', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });

    // 两个**不同**的项目目录（同路径会被 openProject 去重成同一个项目）
    const rootA = await tmp();
    const rootB = await tmp();
    const { project: p1 } = await runtime.openProject({ rootPath: rootA, name: '项目A' });
    const { project: p2 } = await runtime.openProject({ rootPath: rootB, name: '项目B' });

    // 项目 A 的 Agent 在写一个**绝对路径**的共享库
    const sharedLib = path.resolve(rootB, 'shared-lib');
    await store.putExecutor({
      id: 'exe_running',
      projectId: p1.id,
      sessionId: 'd1',
      label: 'A 的执行者',
      goal: '改共享库',
      access: 'readwrite',
      writeScope: [sharedLib],
      status: 'running',
      summary: null,
      blockedReason: null,
      metrics: { turns: 0, steps: 0, tokensIn: 0, tokensOut: 0, cachedTokens: null, durationMs: 0, contextTokens: null },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: null,
    });

    // 项目 B 派活去写同一个位置 → 应当被拒
    await assert.rejects(
      () =>
        runtime.spawn(p2.id, {
          label: 'Supervisor 的执行者',
          goal: '也改共享库',
          writeScope: ['shared-lib/strings.ts'],
        }),
      /已拒绝派活/,
    );

    await runtime.dispose();
  });

  it('两个项目的同名目录不误伤', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: '好' })) });

    const { project: p1 } = await runtime.openProject({ rootPath: await tmp(), name: 'X' });
    const { project: p2 } = await runtime.openProject({ rootPath: await tmp(), name: 'Y' });

    await store.putExecutor({
      id: 'exe_x',
      projectId: p1.id,
      sessionId: 'd1',
      label: 'X 的执行者',
      goal: 'g',
      access: 'readwrite',
      writeScope: ['src'],
      status: 'running',
      summary: null,
      blockedReason: null,
      metrics: { turns: 0, steps: 0, tokensIn: 0, tokensOut: 0, cachedTokens: null, durationMs: 0, contextTokens: null },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: null,
    });

    // 项目 Y 也改自己的 src —— 不该被拦
    const result = await runtime.spawn(p2.id, {
      label: 'Y 的执行者',
      goal: 'g',
      writeScope: ['src'],
    });
    assert.equal(result.admitted, true, '不同项目各自的 src 不该冲突');

    await runtime.dispose();
  });
});
