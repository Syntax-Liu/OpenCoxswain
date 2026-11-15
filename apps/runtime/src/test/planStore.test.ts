/**
 * 方案存储测试。
 *
 * 与 store.test.ts 同一取向：**同一套断言跑两个后端**（内存 / SQLite），
 * 确保"换后端不改变行为"。
 *
 * 方案是跨轮次活着的东西——断电重开后它必须还在，所以持久化正确性
 * 比普通字段更要紧。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MemoryStore, type Store, type PlanRow } from '../store/store.js';
import { SqliteStore } from '../store/sqlite.js';
import { createPlan, transition } from '../orchestrator/plan.js';

let dir: string;

/** 建过的 store 都记下来，after 里统一关，否则 Windows 上删不掉 db 文件。 */
const opened: Store[] = [];

function factories(): Array<[string, () => Promise<Store>]> {
  const track = (s: Store): Store => {
    opened.push(s);
    return s;
  };
  return [
    ['memory', async () => track(new MemoryStore())],
    ['sqlite', async () => track(new SqliteStore({ file: path.join(dir, 'test.db') }))],
  ];
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ocx-plan-'));
});

after(async () => {
  // 先关连接：Windows 上不关就 EBUSY，删不掉文件
  for (const s of opened) {
    await s.close().catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function samplePlan(over: Partial<PlanRow> = {}): PlanRow {
  const base = createPlan({
    id: `plan_${Math.random().toString(36).slice(2, 10)}`,
    projectId: 'prj_1',
    goal: '做一个 XX 软件',
    steps: [
      {
        id: 'P0',
        title: '调研',
        goal: '调研架构',
        writeScope: ['readonly'],
        criteria: [{ id: 'c1', desc: '有报告', type: 'human' }],
        acceptancePolicy: 'unverified_only',
      },
      {
        id: 'P1',
        title: '实现',
        goal: '实现核心',
        writeScope: ['src'],
        criteria: [],
        acceptancePolicy: 'unverified_only',
        dependsOn: ['P0'],
      },
    ],
  });
  return { ...base, ...over };
}

for (const [label, factory] of factories()) {
  describe(`方案存储（${label}）`, () => {
    it('写入后能读回来，字段完整', async () => {
      const store = await factory();
      const plan = samplePlan();
      await store.putPlan(plan);
      const got = store.getPlan(plan.id);
      assert.ok(got);
      assert.equal(got.goal, plan.goal);
      assert.equal(got.status, 'draft');
      assert.equal(got.steps.length, 2);
      assert.equal(got.steps[0]?.title, '调研');
      assert.deepEqual(got.steps[1]?.dependsOn, ['P0']);
    });

    it('**步骤与验收标准经过 JSON 往返不丢结构**', async () => {
      const store = await factory();
      const plan = samplePlan();
      await store.putPlan(plan);
      const got = store.getPlan(plan.id)!;
      assert.equal(got.steps[0]?.attempts, 0);
      assert.equal(got.steps[0]?.status, 'pending');
      assert.deepEqual(got.steps[0]?.criteria, [
        { id: 'c1', desc: '有报告', type: 'human' },
      ]);
    });

    it('更新会覆盖字段（状态与批准信息）', async () => {
      const store = await factory();
      const plan = samplePlan();
      await store.putPlan(plan);

      const approved = transition(transition(plan, 'awaiting-approval'), 'approved');
      await store.putPlan(approved);

      const got = store.getPlan(plan.id)!;
      assert.equal(got.status, 'approved');
      assert.equal(got.approvedBy, 'user');
      assert.ok(got.approvedAt !== null);
    });

    it('改动记录（amendments）能持久化', async () => {
      const store = await factory();
      const plan = samplePlan({
        amendments: [
          {
            id: 'amd_1',
            kind: 'big',
            where: ['P1'],
            what: '新增数据迁移',
            why: '必须先迁移',
            criteriaTouched: true,
            decidedAt: 123,
          },
        ],
      });
      await store.putPlan(plan);
      const got = store.getPlan(plan.id)!;
      assert.equal(got.amendments.length, 1);
      assert.equal(got.amendments[0]?.kind, 'big');
      assert.equal(got.amendments[0]?.criteriaTouched, true);
    });

    it('查不到时返回 undefined，不是空对象', async () => {
      const store = await factory();
      assert.equal(store.getPlan('plan_nope'), undefined);
    });

    it('**activePlanOf 排除 done 与 superseded**', async () => {
      const store = await factory();
      const pid = `prj_${Math.random().toString(36).slice(2, 8)}`;

      await store.putPlan(samplePlan({ projectId: pid, id: 'p_done', status: 'done' }));
      await store.putPlan(samplePlan({ projectId: pid, id: 'p_sup', status: 'superseded' }));
      // done/superseded 都不算活跃
      assert.equal(store.activePlanOf(pid), undefined);

      await store.putPlan(samplePlan({ projectId: pid, id: 'p_live', status: 'approved' }));
      assert.equal(store.activePlanOf(pid)?.id, 'p_live');
    });

    it('activePlanOf 有多条活跃时取最新', async () => {
      const store = await factory();
      const pid = `prj_${Math.random().toString(36).slice(2, 8)}`;
      await store.putPlan(
        samplePlan({ projectId: pid, id: 'p_old', status: 'approved', createdAt: 1000 }),
      );
      await store.putPlan(
        samplePlan({ projectId: pid, id: 'p_new', status: 'awaiting-approval', createdAt: 2000 }),
      );
      assert.equal(store.activePlanOf(pid)?.id, 'p_new');
    });

    it('activePlanOf 只看本项目', async () => {
      const store = await factory();
      await store.putPlan(samplePlan({ projectId: 'prj_a', id: 'p_a', status: 'approved' }));
      await store.putPlan(samplePlan({ projectId: 'prj_b', id: 'p_b', status: 'approved' }));
      assert.equal(store.activePlanOf('prj_a')?.id, 'p_a');
      assert.equal(store.activePlanOf('prj_b')?.id, 'p_b');
    });

    it('listPlans 能按项目与状态过滤', async () => {
      const store = await factory();
      const pid = `prj_${Math.random().toString(36).slice(2, 8)}`;
      await store.putPlan(samplePlan({ projectId: pid, id: 'a', status: 'draft' }));
      await store.putPlan(samplePlan({ projectId: pid, id: 'b', status: 'approved' }));

      assert.equal(store.listPlans({ projectId: pid }).length, 2);
      assert.equal(store.listPlans({ projectId: pid, status: ['approved'] }).length, 1);
    });
  });
}

describe('方案持久化：SQLite 重开后仍在', () => {
  it('**断电重开，方案与进度都在**（plan-approval §十二 的验收项）', async () => {
    const file = path.join(dir, 'restart.db');

    const first = new SqliteStore({ file });
    const plan = samplePlan({ id: 'plan_restart' });
    const progressed = {
      ...plan,
      status: 'approved' as const,
      approvedAt: 123456,
      approvedBy: 'user' as const,
      steps: plan.steps.map((s, i) =>
        i === 0 ? { ...s, status: 'done' as const, attempts: 1 } : s,
      ),
    };
    await first.putPlan(progressed);
    await first.close?.();

    // 模拟第二次启动
    const second = new SqliteStore({ file });
    const got = second.getPlan('plan_restart');
    assert.ok(got, '重开后方案不见了');
    assert.equal(got.status, 'approved');
    assert.equal(got.steps[0]?.status, 'done', '步骤进度丢了');
    assert.equal(got.steps[0]?.attempts, 1, '重试计数丢了');
    assert.equal(got.approvedBy, 'user');
    await second.close?.();
  });
});

