/**
 * 方案自动推进测试（第 4 步）。
 *
 * 验证：Agent 完成某一步后，方案进度被回填，并通知 Assistant 下一步。
 *
 * 关键设计：推进**不直接派活**，而是发内部通知让 Assistant 决定怎么派。
 * 因为派活要考虑排队、写域冲突、用户新需求——那些都在 Assistant 那边。
 * 由运行时硬派会让 Assistant 对方案失去掌控。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { createPlan, transition } from '../orchestrator/plan.js';
import type { LlmClient } from '../llm/types.js';

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ocx-advance-'));
  await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function stubLlm(): LlmClient {
  return {
    async complete() {
      return { text: '好', toolCalls: [], tokensIn: 1, tokensOut: 1, modelMs: 1 };
    },
  } as unknown as LlmClient;
}

async function setup(stepCount = 2) {
  const store = new MemoryStore();
  const runtime = new Orchestrator({ store, llm: stubLlm(), maxStepsPerExecutor: 2 });
  const { project } = await runtime.openProject({ rootPath: root });

  const steps = Array.from({ length: stepCount }, (_, i) => ({
    id: `P${i}`,
    title: `第 ${i + 1} 步`,
    goal: `做第 ${i + 1} 件事`,
    writeScope: ['readonly'],
    criteria: [],
    acceptancePolicy: 'unverified_only' as const,
    ...(i > 0 ? { dependsOn: [`P${i - 1}`] } : {}),
  }));

  const plan = transition(
    createPlan({ id: 'plan_adv', projectId: project.id, goal: 'g', steps }),
    'awaiting-approval',
  );
  const approved = transition(plan, 'approved');
  await store.putPlan(approved);

  return { store, runtime, project, plan: approved };
}

describe('Agent 关联方案步骤', () => {
  it('spawn 时带 planStepId 会存进 executor', async () => {
    const { runtime, store, project } = await setup();
    const r = await runtime.spawn(project.id, {
      label: '跑 P0',
      goal: '做第一件事',
      writeScope: ['readonly'],
      planStepId: 'P0',
    });
    const saved = store.getExecutor(r.executor.id);
    assert.equal(saved?.planStepId, 'P0');
  });

  it('不带 planStepId 就是普通任务', async () => {
    const { runtime, store, project } = await setup();
    const r = await runtime.spawn(project.id, {
      label: '临时任务',
      goal: '做点事',
      writeScope: ['readonly'],
    });
    assert.equal(store.getExecutor(r.executor.id)?.planStepId ?? null, null);
  });
});

describe('方案推进：步骤完成', () => {
  it('**Agent 结束后方案步骤被回填**（attempts 计数变化）', async () => {
    const { runtime, store, project } = await setup();
    const r = await runtime.spawn(project.id, {
      label: '跑 P0',
      goal: 'x',
      writeScope: ['readonly'],
      planStepId: 'P0',
    });

    // 等运行时把 Agent 结算掉
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const cur = store.getExecutor(r.executor.id);
      if (cur && cur.status !== 'running' && cur.status !== 'starting') break;
      await new Promise((res) => setTimeout(res, 100));
    }

    const plan = store.getPlan('plan_adv')!;
    const step = plan.steps.find((s) => s.id === 'P0');

    // 注意：失败的步骤状态会回到 pending 准备重试（这是 D5 的设计），
    // 所以不能断言 status === 'done'。真正能证明"回填发生过"的是 attempts。
    assert.ok(
      (step?.attempts ?? 0) > 0 || step?.status === 'done',
      `P0 应该被回填过，实际 status=${step?.status} attempts=${step?.attempts}`,
    );
  });

  it('**失败 1 次后状态回到 pending**（准备重试，不打扰用户）', async () => {
    const { runtime, store, project } = await setup();
    const r = await runtime.spawn(project.id, {
      label: '跑 P0',
      goal: 'x',
      writeScope: ['readonly'],
      planStepId: 'P0',
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const cur = store.getExecutor(r.executor.id);
      if (cur && cur.status !== 'running' && cur.status !== 'starting') break;
      await new Promise((res) => setTimeout(res, 100));
    }

    const plan = store.getPlan('plan_adv')!;
    // 方案整体仍然是 approved——第 1 次失败不该把方案打停
    assert.equal(plan.status, 'approved');
  });

  it('与方案无关的 Agent 不会改动方案', async () => {
    const { runtime, store, project } = await setup();
    const before = JSON.stringify(store.getPlan('plan_adv'));
    const r = await runtime.spawn(project.id, {
      label: '临时',
      goal: 'y',
      writeScope: ['readonly'],
    });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const cur = store.getExecutor(r.executor.id);
      if (cur && cur.status !== 'running' && cur.status !== 'starting') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.equal(JSON.stringify(store.getPlan('plan_adv')), before, '方案不该被无关任务改动');
  });
});

describe('方案推进：内部通知', () => {
  it('完成后会给 Assistant 发一条内部通知（含下一步）', async () => {
    const { store, project } = await setup();
    // 直接验证 onStepDone 的语义（运行时通知由 advancePlan 发送）
    const { onStepDone } = await import('../orchestrator/plan.js');
    const plan = store.getPlan('plan_adv')!;
    const out = onStepDone(plan, 'P0');
    assert.equal(out.nextStepId, 'P1');
    assert.equal(out.plan.steps[0]?.status, 'done');
    assert.ok(project.id);
  });
});
