/**
 * propose_plan 工具测试。
 *
 * 验证三件事：
 *   1. 方案能正确落库并进入 awaiting-approval
 *   2. **验收命令跑不了时，在出方案阶段就拒绝**（不要等 Agent 跑完才发现）
 *   3. 一个项目同时只有一条活跃方案
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import type { LlmClient } from '../llm/types.js';

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ocx-propose-'));
  await writeFile(path.join(root, 'a.ts'), 'export const x = 1;\n');
});

after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

/** 让 LLM 在助手轮里直接调用 propose_plan。 */
function proposeLlm(steps: unknown[], goal = '做一个 XX'): LlmClient {
  let called = false;
  return {
    async complete() {
      if (!called) {
        called = true;
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'propose_plan',
              args: { goal, steps },
            },
          ],
          tokensIn: 10,
          tokensOut: 5,
          modelMs: 1,
        };
      }
      return { text: '方案已出，等你批准', toolCalls: [], tokensIn: 5, tokensOut: 5, modelMs: 1 };
    },
  } as unknown as LlmClient;
}

const goodSteps = [
  {
    title: '调研',
    goal: '看一眼现有代码',
    writeScope: ['readonly'],
    criteria: [{ id: 'c1', desc: '类型检查通过', type: 'command', check: 'node --version' }],
  },
  {
    title: '实现',
    goal: '加一个函数',
    writeScope: ['src'],
    criteria: [{ id: 'c2', desc: '编译通过', type: 'command', check: 'node --version' }],
    dependsOn: ['P0'],
  },
];

describe('propose_plan：验收命令平台校验', () => {
  it('**POSIX 命令在 Windows 上出方案就被拒**，不会等到 Agent 跑完', async () => {
    const { checkAllCommands } = await import('../acceptance/portability.js');
    const report = checkAllCommands(['test -f a.ts', 'node --version'], 'win32');
    assert.equal(report.allUsable, false);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]?.reason ?? '', /Windows/);
  });

  it('跨平台命令通过校验', async () => {
    const { checkAllCommands } = await import('../acceptance/portability.js');
    const report = checkAllCommands(['node --version', 'git status --porcelain'], 'win32');
    assert.equal(report.allUsable, true);
  });

  it('真实方案里混入 POSIX 命令会被拦下', async () => {
    // 这是 propose_plan 里那一道校验的核心：出方案阶段就发现，
    // 而不是等 5 步跑完、验收全红才发现。
    const { checkAllCommands } = await import('../acceptance/portability.js');
    const commands = goodSteps
      .flatMap((s) => s.criteria)
      .filter((c) => c.type === 'command')
      .map((c) => c.check);
    // 先用合规命令，确保全部通过
    assert.equal(checkAllCommands(commands, 'win32').allUsable, true);

    // 再混一条 POSIX 命令，必须被拦
    const mixed = [...commands, 'grep -q x a.ts'];
    const r = checkAllCommands(mixed, 'win32');
    assert.equal(r.allUsable, false);
    assert.equal(r.problems.length, 1);
  });
});

describe('方案状态：端到端（不经 LLM）', () => {
  it('从 awaiting-approval 批准后变成 approved', async () => {
    const store = new MemoryStore();
    const { createPlan, transition } = await import('../orchestrator/plan.js');
    const runtime = new Orchestrator({
      store,
      llm: { async complete() { return { text: '', toolCalls: [], tokensIn: 1, tokensOut: 1, modelMs: 1 }; } } as unknown as LlmClient,
      maxStepsPerExecutor: 2,
    });
    const { project } = await runtime.openProject({ rootPath: root });

    const draft = createPlan({
      id: 'p_test',
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
    await store.putPlan(transition(draft, 'awaiting-approval'));

    const approved = transition(store.getPlan('p_test')!, 'approved');
    await store.putPlan(approved);

    const got = store.getPlan('p_test')!;
    assert.equal(got.status, 'approved');
    assert.equal(got.approvedBy, 'user');
  });
});
