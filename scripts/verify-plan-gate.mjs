/**
 * 端到端验证：方案把关开关在**真实运行时**里确实生效。
 *
 * 直接用 store + orchestrator，不经过 HTTP，但用的是真实代码路径。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../apps/runtime/dist/orchestrator.js';
import { MemoryStore } from '../apps/runtime/dist/store/store.js';
import { parsePlanGate } from '../apps/runtime/dist/settings/planGate.js';
import { createPlan, transition } from '../apps/runtime/dist/orchestrator/plan.js';

const root = await mkdtemp(path.join(tmpdir(), 'ocx-gate-e2e-'));

const llm = {
  async complete() {
    return { text: 'ok', toolCalls: [], tokensIn: 1, tokensOut: 1, modelMs: 1 };
  },
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function scenario(label, gateMode, planStatus) {
  const store = new MemoryStore();
  const runtime = new Orchestrator({
    store,
    llm,
    maxStepsPerExecutor: 2,
    ...(gateMode ? { planGate: parsePlanGate(gateMode) } : {}),
  });
  const { project } = await runtime.openProject({ rootPath: root });

  if (planStatus) {
    let plan = createPlan({
      id: 'p1',
      projectId: project.id,
      goal: 'g',
      steps: [
        {
          id: 'P0',
          title: 't',
          goal: 'g',
          writeScope: ['readonly'],
          criteria: [],
          acceptancePolicy: 'unverified_only',
        },
      ],
    });
    if (planStatus === 'awaiting-approval') plan = transition(plan, 'awaiting-approval');
    if (planStatus === 'approved') plan = transition(transition(plan, 'awaiting-approval'), 'approved');
    await store.putPlan(plan);
  }

  let spawned = false;
  let error = '';
  try {
    const r = await runtime.spawn(project.id, {
      label: 'task',
      goal: 'do it',
      writeScope: ['readonly'],
    });
    spawned = Boolean(r.executor?.id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { spawned, error };
}

console.log('方案把关端到端验证\n');

let r;

r = await scenario('默认（不传 planGate）', null, null);
check('默认配置：能派活', r.spawned, r.error);

r = await scenario('off + 有未批准方案', { mode: 'off' }, 'awaiting-approval');
check('off：即使方案未批准也能派活（不停摆）', r.spawned, r.error);

r = await scenario('on + 无方案', { mode: 'on' }, null);
check('on：没有方案时照常派活', r.spawned, r.error);

r = await scenario('on + 方案待批准', { mode: 'on' }, 'awaiting-approval');
check('on：方案待批准时被拒绝', !r.spawned, r.error);
check('拒绝原因说明是「批准」', /批准/.test(r.error), r.error);

r = await scenario('on + 方案已批准', { mode: 'on' }, 'approved');
check('on：方案批准后放行', r.spawned, r.error);

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
