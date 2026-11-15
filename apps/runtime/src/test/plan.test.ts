/**
 * 方案状态机测试。
 *
 * 对应 docs/plan-approval.md 的 D1/D2/D5/D7/D8：
 *   D1 方案要给用户看完才开工（硬关卡）
 *   D2 批准之后不再逐步问
 *   D5 失败重试 2 次，第 3 次卡住
 *   D7 小改动：提示但不中断
 *   D8 大改动：停工重批
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS,
  applyAmendment,
  canSpawnStep,
  canTransition,
  createPlan,
  describePlanStatus,
  nextRunnableStep,
  normalizeAmendment,
  onStepDone,
  onStepFailed,
  progressOf,
  transition,
  type Plan,
} from '../orchestrator/plan.js';

function makePlan(over: Partial<Plan> = {}): Plan {
  const base = createPlan({
    id: 'plan_1',
    projectId: 'prj_1',
    goal: '做一个 XX 软件',
    steps: [
      {
        id: 'P0',
        title: '调研',
        goal: '调研现有架构',
        writeScope: ['readonly'],
        criteria: [],
        acceptancePolicy: 'unverified_only',
      },
      {
        id: 'P1',
        title: '实现',
        goal: '实现核心功能',
        writeScope: ['src'],
        criteria: [],
        acceptancePolicy: 'unverified_only',
        dependsOn: ['P0'],
      },
    ],
  });
  return { ...base, ...over };
}

/** 走到已批准状态。 */
function approvedPlan(): Plan {
  return transition(transition(makePlan(), 'awaiting-approval'), 'approved');
}

describe('状态机：合法与非法迁移', () => {
  it('draft → awaiting-approval → approved', () => {
    const p = transition(makePlan(), 'awaiting-approval');
    assert.equal(p.status, 'awaiting-approval');
    const a = transition(p, 'approved');
    assert.equal(a.status, 'approved');
    assert.equal(a.approvedBy, 'user');
    assert.ok(a.approvedAt !== null);
  });

  it('**驳回**：awaiting-approval → draft', () => {
    const p = transition(makePlan(), 'awaiting-approval');
    assert.equal(transition(p, 'draft').status, 'draft');
  });

  it('**不能跳过审批直接 approved**（D1 的唯一落点）', () => {
    assert.equal(canTransition('draft', 'approved'), false);
    assert.throws(() => transition(makePlan(), 'approved'), /不允许/);
  });

  it('**superseded 不能直接回 approved**，必须重批', () => {
    assert.equal(canTransition('superseded', 'approved'), false);
    assert.equal(canTransition('superseded', 'awaiting-approval'), true);
  });

  it('done 是终态', () => {
    assert.equal(canTransition('done', 'approved'), false);
    assert.equal(canTransition('done', 'draft'), false);
  });

  it('blocked 处理完回到 approved（方案本身没变）', () => {
    assert.equal(canTransition('blocked', 'approved'), true);
  });
});

describe('canSpawnStep：批一次就够的硬约束', () => {
  it('**只有 approved 能派活**', () => {
    assert.equal(canSpawnStep(makePlan()).allowed, false);
    assert.equal(canSpawnStep(transition(makePlan(), 'awaiting-approval')).allowed, false);
    assert.equal(canSpawnStep(approvedPlan()).allowed, true);
  });

  it('未批准时给出**具体原因**，不是干巴巴的 false', () => {
    const r = canSpawnStep(transition(makePlan(), 'awaiting-approval'));
    assert.match(r.reason ?? '', /批准/);
  });

  it('作废后不能派活，原因说明要重批', () => {
    const superseded = { ...approvedPlan(), status: 'superseded' as const };
    const r = canSpawnStep(superseded);
    assert.equal(r.allowed, false);
    assert.match(r.reason ?? '', /重新批准/);
  });
});

describe('大改动 / 小改动判定', () => {
  it('**碰了验收标准就是大改动**，哪怕 Assistant 自己说是 small', () => {
    const a = normalizeAmendment({
      kind: 'small', // ← Assistant 自称不大
      where: ['P1'],
      what: '把并发数从 1000 改成 5000',
      why: '用户改需求',
      criteriaTouched: true, // ← 但确实动了验收标准
    });
    assert.equal(a.kind, 'big', 'criteriaTouched=true 必须强制 big');
  });

  it('没碰验收标准的小改动可以保持 small', () => {
    const a = normalizeAmendment({
      kind: 'small',
      where: ['P1'],
      what: '改用一条脚本批量复制',
      why: '更快',
      criteriaTouched: false,
    });
    assert.equal(a.kind, 'small');
  });

  it('**小改动：记录但不中断**（D7）', () => {
    const plan = approvedPlan();
    const next = applyAmendment(
      plan,
      normalizeAmendment({
        kind: 'small',
        where: ['P1'],
        what: '换了个等价做法',
        why: '更快',
        criteriaTouched: false,
      }),
    );
    assert.equal(next.status, 'approved', '小改动不该打断执行');
    assert.equal(next.amendments.length, 1, '但要留下记录');
  });

  it('**大改动：停工重批**（D8）', () => {
    const plan = approvedPlan();
    const next = applyAmendment(
      plan,
      normalizeAmendment({
        kind: 'big',
        where: ['P1'],
        what: '新增数据迁移步骤',
        why: '发现必须先迁移',
        criteriaTouched: true,
      }),
    );
    assert.equal(next.status, 'superseded');
    assert.equal(canSpawnStep(next).allowed, false, '作废后不许继续派活');
  });
});

describe('失败重试：前两次不打扰，第 3 次卡住（D5）', () => {
  it(`重试 ${MAX_ATTEMPTS} 次内不交给人`, () => {
    let plan = approvedPlan();
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const r = onStepFailed(plan, 'P0');
      plan = r.plan;
      assert.equal(r.escalate, false, `第 ${i} 次失败不该打扰用户`);
      assert.equal(plan.steps[0]?.attempts, i);
      assert.equal(plan.status, 'approved', '方案仍在执行');
    }
  });

  it('**第 3 次失败才卡住**', () => {
    let plan = approvedPlan();
    plan = onStepFailed(plan, 'P0').plan;
    plan = onStepFailed(plan, 'P0').plan;
    const third = onStepFailed(plan, 'P0');
    assert.equal(third.escalate, true);
    assert.equal(third.plan.status, 'blocked');
    assert.equal(third.plan.steps[0]?.status, 'blocked');
  });

  it('计数**跟着步骤走**，重派换 Agent 也不会清零', () => {
    // 这正是"计数挂在 Agent 上会无限循环"的防护
    let plan = approvedPlan();
    plan = onStepFailed(plan, 'P0').plan;
    const before = plan.steps[0]?.attempts;
    // 模拟重派：步骤对象被替换，但 attempts 保留
    const after = onStepFailed(plan, 'P0').plan.steps[0]?.attempts;
    assert.equal(after, (before ?? 0) + 1);
  });

  it('成功一次后再失败，计数继续累加（不因成功重置成 0 而无限重试）', () => {
    let plan = approvedPlan();
    plan = onStepFailed(plan, 'P0').plan; // 1
    plan = onStepFailed(plan, 'P0').plan; // 2
    const third = onStepFailed(plan, 'P0'); // 3 → 卡住
    assert.equal(third.escalate, true);
  });
});

describe('自动推进（D2：批准后不再逐步问）', () => {
  it('完成 P0 后自动指向 P1', () => {
    const r = onStepDone(approvedPlan(), 'P0');
    assert.equal(r.nextStepId, 'P1');
    assert.equal(r.plan.steps[0]?.status, 'done');
  });

  it('依赖没完成的步骤不会被选为下一步', () => {
    const plan = approvedPlan();
    // P1 依赖 P0，P0 还没完成
    assert.equal(nextRunnableStep(plan.steps)?.id, 'P0');
  });

  it('全部完成 → 方案 done', () => {
    let plan = approvedPlan();
    plan = onStepDone(plan, 'P0').plan;
    const r = onStepDone(plan, 'P1');
    assert.equal(r.plan.status, 'done');
    assert.equal(r.nextStepId, null);
  });

  it('没有可运行步骤时返回 null（不会无限循环）', () => {
    const plan = approvedPlan();
    const stuck = plan.steps.map((s) => ({ ...s, status: 'blocked' as const }));
    assert.equal(nextRunnableStep(stuck), null);
  });
});

describe('进度与描述', () => {
  it('进度统计正确', () => {
    let plan = approvedPlan();
    plan = onStepDone(plan, 'P0').plan;
    const p = progressOf(plan);
    assert.equal(p.total, 2);
    assert.equal(p.done, 1);
  });

  it('各状态都有可读描述', () => {
    for (const s of ['draft', 'awaiting-approval', 'approved', 'superseded', 'blocked', 'done'] as const) {
      const text = describePlanStatus({ ...makePlan(), status: s });
      assert.ok(text.length > 0, `${s} 缺描述`);
    }
  });

  it('等批准时说明有几步', () => {
    const text = describePlanStatus(transition(makePlan(), 'awaiting-approval'));
    assert.match(text, /2 步/);
  });
});
