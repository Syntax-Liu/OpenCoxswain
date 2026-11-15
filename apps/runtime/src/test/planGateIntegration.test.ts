/**
 * 方案把关的集成测试：确认它**真的接进了 spawn**。
 *
 * 只测 parsePlanGate 不够——那个函数再对，没接进派活点也等于没有。
 * 这里直接起一个 Orchestrator，观察三种情形：
 *   1. 默认 off：派活照旧成功（**最关键**，不能停摆）
 *   2. on + 方案未批准：派活被拒
 *   3. on + 方案已批准：派活放行
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { parsePlanGate } from '../settings/planGate.js';
import { createPlan, transition } from '../orchestrator/plan.js';
import type { LlmClient } from '../llm/types.js';

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ocx-gate-'));
  await writeFile(path.join(root, 'README.md'), '# demo\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 最简 LLM：助手只回一句话，Agent 跑一轮就结束。 */
function stubLlm(): LlmClient {
  return {
    async complete() {
      return {
        text: '做完了',
        toolCalls: [],
        tokensIn: 10,
        tokensOut: 5,
        modelMs: 1,
      };
    },
  } as unknown as LlmClient;
}

async function makeRuntime(planGate?: ReturnType<typeof parsePlanGate>) {
  const store = new MemoryStore();
  const runtime = new Orchestrator({
    store,
    llm: stubLlm(),
    maxStepsPerExecutor: 3,
    ...(planGate ? { planGate } : {}),
  });
  const { project } = await runtime.openProject({ rootPath: root });
  return { runtime, store, project };
}

/** 放一个指定状态的方案到 store。 */
async function putPlan(
  store: MemoryStore,
  projectId: string,
  status: 'draft' | 'awaiting-approval' | 'approved',
) {
  let plan = createPlan({
    id: `plan_${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    goal: '做一个 XX',
    steps: [
      {
        id: 'P0',
        title: '实现',
        goal: '改点东西',
        writeScope: ['src'],
        criteria: [],
        acceptancePolicy: 'unverified_only',
      },
    ],
  });
  if (status === 'awaiting-approval') plan = transition(plan, 'awaiting-approval');
  if (status === 'approved') plan = transition(transition(plan, 'awaiting-approval'), 'approved');
  await store.putPlan(plan);
  return plan;
}

describe('方案把关：默认 off，行为与没有把关时一致', () => {
  it('**没配 planGate，派活照旧成功**', async () => {
    const { runtime, project } = await makeRuntime();
    const r = await runtime.spawn(project.id, {
      label: '普通任务',
      goal: '做点事',
      writeScope: ['readonly'],
    });
    assert.ok(r.executor.id, '默认 off 时应该能派出去');
  });

  it('**默认设置下，有未批准的方案也不拦**（界面上没有批准入口）', async () => {
    const { runtime, store, project } = await makeRuntime();
    await putPlan(store, project.id, 'awaiting-approval');
    const r = await runtime.spawn(project.id, {
      label: '普通任务',
      goal: '做点事',
      writeScope: ['readonly'],
    });
    assert.ok(
      r.executor.id,
      '界面上已经没有批准入口了，此时拦人等于把人锁死——默认必须放行',
    );
  });
});

describe('方案把关：on 时拦未批准的', () => {
  it('**方案 awaiting-approval → 派活被拒**', async () => {
    const { runtime, store, project } = await makeRuntime(parsePlanGate({ mode: 'on' }));
    await putPlan(store, project.id, 'awaiting-approval');

    await assert.rejects(
      () =>
        runtime.spawn(project.id, {
          label: '方案内步骤',
          goal: '做点事',
          writeScope: ['readonly'],
        }),
      /已拒绝派活/,
    );
  });

  it('拒绝原因说明是「还没批准」，不是含糊的错误', async () => {
    const { runtime, store, project } = await makeRuntime(parsePlanGate({ mode: 'on' }));
    await putPlan(store, project.id, 'awaiting-approval');
    await assert.rejects(
      () =>
        runtime.spawn(project.id, {
          label: 'x',
          goal: 'y',
          writeScope: ['readonly'],
        }),
      /批准/,
    );
  });

  it('**方案已批准 → 放行**', async () => {
    const { runtime, store, project } = await makeRuntime(parsePlanGate({ mode: 'on' }));
    await putPlan(store, project.id, 'approved');
    const r = await runtime.spawn(project.id, {
      label: '方案内步骤',
      goal: '做点事',
      writeScope: ['readonly'],
    });
    assert.ok(r.executor.id, '批准后应该能派');
  });

  it('**没有方案时 on 也不拦**（不是所有活都必须先有计划）', async () => {
    const { runtime, project } = await makeRuntime(parsePlanGate({ mode: 'on' }));
    const r = await runtime.spawn(project.id, {
      label: '临时任务',
      goal: '做点事',
      writeScope: ['readonly'],
    });
    assert.ok(r.executor.id);
  });

  it('draft 状态也拦（还没交给你看）', async () => {
    const { runtime, store, project } = await makeRuntime(parsePlanGate({ mode: 'on' }));
    await putPlan(store, project.id, 'draft');
    await assert.rejects(
      () =>
        runtime.spawn(project.id, {
          label: 'x',
          goal: 'y',
          writeScope: ['readonly'],
        }),
      /已拒绝派活/,
    );
  });
});
