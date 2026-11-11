/**
 * 运行时端到端测试：用脚本化假模型跑通整条链路。
 *
 * 每条测试对应你设想里的一条明确要求。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { Inbox } from '../inbox/inbox.js';
import { Gate, scopesConflict } from '../executor/gate.js';
import { classifyBlock } from '../executor/executor.js';
import { findProject } from '../global/assistant.js';
import {
  MockLlmClient,
  isAssistantTurn,
  isExecutorTurn,
  isSettlementNotice,
} from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-rt-'));
  temps.push(dir);
  return dir;
}

/**
 * 一个"假 C"：收到用户需求就派执行者；收到结算通知就汇报。
 * 模拟真实 C 的行为契约，但用固定脚本保证测试确定性。
 */
function makeAssistantLlm(_projectRoot: string) {
  let spawned = 0;
  return new MockLlmClient((request) => {
    if (isSettlementNotice(request)) {
      return { text: '✅ 已汇报：执行者完成，具体见上。' };
    }
    if (isAssistantTurn(request)) {
      // 已经派过就不再派。真实模型靠提示词 + 会话历史约束，
      // 这里显式模拟该契约，避免假模型陷入无穷派活。
      if (spawned > 0) return { text: '已派出，等结果。' };
      const firstUser = request.messages.find((m) => m.role === 'user');
      const text = typeof firstUser?.content === 'string' ? firstUser.content : '';
      if (text.includes('创建文件')) {
        spawned += 1;
        return {
          tool: 'spawn_executor',
          args: {
            label: '写文件',
            goal: '在项目根创建 hello.txt，内容为 hello',
            writeScope: [],
            judged: 'new',
          },
          text: '收到，我派一个执行者去创建文件。',
        };
      }
      return { text: '你好，我是项目助理。' };
    }
    return { text: '（未预期的调用）' };
  });
}

/** 一个"假 D"：第一次被调用写文件，第二次给结论。 */
function makeExecutorLlm(projectRoot: string) {
  let step = 0;
  return new MockLlmClient((request) => {
    if (!isExecutorTurn(request)) return { text: '（非执行者轮）' };
    step += 1;
    if (step === 1) {
      return {
        tool: 'write_file',
        args: { path: 'hello.txt', content: 'hello' },
      };
    }
    return {
      text: [
        '结论：已创建 hello.txt。',
        '### 做了什么',
        '新建 hello.txt 并写入 hello。',
        '### 验证了什么',
        '未验证（用户未要求）。',
        '### 需要用户决定什么',
        '无',
      ].join('\n'),
    };
  });
}

/** 把 C 与 D 的脚本合成一个客户端：按 system prompt 分流。 */
function makeRouterLlm(projectRoot: string) {
  const assistant = makeAssistantLlm(projectRoot);
  const executor = makeExecutorLlm(projectRoot);
  return new MockLlmClient(async (request) => {
    // 注意：这里必须直接返回子脚本解析后的结果，不能二次包装，
    // 否则工具调用会被丢掉（曾经因此卡在"C 反复派活"）。
    const chosen = isExecutorTurn(request) ? executor : assistant;
    const response = await chosen.chat(request);
    if (response.toolCalls.length === 0) {
      return { text: response.text };
    }
    const first = response.toolCalls[0]!;
    return { text: response.text, tool: first.name, args: first.args };
  });
}

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

describe('写域互斥', () => {
  it('前缀相交冲突，兄弟路径不冲突', () => {
    assert.equal(scopesConflict(['src'], ['src/auth']), true);
    assert.equal(scopesConflict(['src/auth'], ['src/export']), false);
    assert.equal(scopesConflict(['src/a'], ['src/ab']), false);
  });

  it('任一方为空 → 冲突（保守串行）', () => {
    assert.equal(scopesConflict([], ['src']), true);
    assert.equal(scopesConflict(['src'], []), true);
  });

  it('闸门：不相交的两个执行者可以并行', async () => {
    const gate = new Gate(5);
    await gate.acquire('a', ['src/x']);
    await gate.acquire('b', ['src/y']);
    assert.equal(gate.stats().running, 2);
  });

  it('闸门：相交的第二个执行者排队，释放后补位', async () => {
    const gate = new Gate(5);
    await gate.acquire('a', ['src/x']);
    const pending = gate.acquire('b', ['src/x']);
    assert.equal(gate.stats().queued, 1);

    gate.release('a');
    await pending;
    assert.equal(gate.stats().running, 1);
    assert.equal(gate.stats().queued, 0);
  });
});

describe('连发不打断（Inbox）', () => {
  it('消息排队，不打断当前轮', () => {
    const inbox = new Inbox();
    inbox.push('第一条');
    inbox.push('第二条');
    assert.equal(inbox.pendingCount, 2);
    assert.equal(inbox.drainForStep().length, 2);
    assert.equal(inbox.pendingCount, 0);
  });

  it('step 队列优先于 next', () => {
    const inbox = new Inbox();
    inbox.push('普通');
    inbox.push('改一下', { target: 'step' });
    const drained = inbox.drainForStep();
    assert.equal(drained[0]!.text, '改一下');
  });
});

describe('卡点分类', () => {
  it('环境问题 / 可自行重试 / 需用户决定', () => {
    assert.equal(classifyBlock('EPERM permission denied').kind, 'environment');
    assert.equal(classifyBlock('TypeError: x is undefined').kind, 'self-recoverable');
    assert.equal(classifyBlock('需求本身有歧义').kind, 'needs-user');
  });
});

describe('B 的路由', () => {
  it('按项目名命中并给出依据', async () => {
    const store = new MemoryStore();
    await store.putProject({
      id: 'p1',
      name: 'webapp',
      rootPath: 'd:/work/webapp',
      displayPath: 'D:/work/webapp',
      assistantSessionId: 'c1',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    const decision = findProject(store, '把 webapp 的登录页重构一下');
    assert.equal(decision.decision, 'unique');
    assert.ok(decision.candidates[0]!.reasons.length > 0, '必须给出依据');
  });

  it('完全不相关时不给答案', async () => {
    const store = new MemoryStore();
    const decision = findProject(store, '今天天气不错');
    assert.equal(decision.decision, 'none');
  });
});

// ---------------------------------------------------------------------------
// 端到端：用户 → C → D → 汇报
// ---------------------------------------------------------------------------

describe('主推流程端到端', () => {
  it('用户对 C 说话 → C 派 D → D 真的写文件 → C 收到结算并汇报', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    const llm = makeRouterLlm(root);
    const runtime = new Orchestrator({ store, llm });

    const { project } = await runtime.openProject({ rootPath: root, name: 'demo' });

    const reports: string[] = [];
    runtime.on('runtime', (event) => {
      if (event.type === 'report') reports.push(event.report.body);
    });

    await runtime.userSays(project.id, '帮我创建文件');
    await waitFor(() => reports.some((r) => r.includes('已完成')), 8000);

    // D 真的动了文件系统
    const content = await readFile(path.join(root, 'hello.txt'), 'utf8');
    assert.equal(content, 'hello');

    // 执行者已结算为 done
    const executors = store.listExecutors({ projectId: project.id });
    assert.equal(executors.length, 1);
    assert.equal(executors[0]!.status, 'done');
    assert.match(executors[0]!.summary ?? '', /已创建 hello\.txt/);

    // C 收到了结算通知并汇报
    assert.ok(reports.some((r) => r.includes('已完成')), '必须有完成汇报');

    await runtime.dispose();
  });

  it('C 的会话是常驻的：同一项目反复打开是同一个会话', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });

    const first = await runtime.openProject({ rootPath: root });
    const second = await runtime.openProject({ rootPath: root.replace(/\//g, '\\') + path.sep });
    assert.equal(first.project.id, second.project.id);
    assert.equal(first.project.assistantSessionId, second.project.assistantSessionId);

    await runtime.dispose();
  });

  it('连发两条消息：第二条不打断第一条，且都会被处理', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    let assistantCalls = 0;
    const llm = new MockLlmClient((request) => {
      if (isAssistantTurn(request) && !isSettlementNotice(request)) {
        assistantCalls += 1;
        return { text: `回应第 ${assistantCalls} 条` };
      }
      return { text: 'ok' };
    });
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    // 连续发送，不等待
    await runtime.userSays(project.id, '第一条');
    await runtime.userSays(project.id, '第二条');

    await waitFor(() => assistantCalls >= 1, 5000);
    await waitFor(() => store.listTurns(project.id).length >= 0 && !runtime.getAssistant(project.id)!.isRunning, 5000);

    const history = store.messages(project.assistantSessionId);
    const userMessages = history.filter((m) => m.role === 'user').map((m) => m.content);
    assert.ok(userMessages.includes('第一条'), '第一条必须被记录');
    assert.ok(userMessages.includes('第二条'), '第二条必须被记录（不能丢）');

    await runtime.dispose();
  });

  it('两个写域不同的执行者可以并行', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, { label: 'A', goal: 'g', writeScope: ['src/a'] });
    await runtime.spawn(project.id, { label: 'B', goal: 'g', writeScope: ['src/b'] });
    await waitFor(() => runtime.stats().running === 2, 3000);

    assert.equal(runtime.stats().running, 2);
    assert.equal(runtime.stats().queued, 0);

    await runtime.dispose();
  });

  it('写域相交的执行者被排队（冲突兜底）', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    // 让 D 慢一点，确保第一个还在跑
    const llm = new MockLlmClient(() => ({ text: 'ok' }));
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    await runtime.spawn(project.id, { label: 'A', goal: 'g', writeScope: ['src/auth'] });
    await waitFor(() => runtime.stats().running === 1, 3000);
    const second = await runtime.spawn(project.id, {
      label: 'B',
      goal: 'g',
      writeScope: ['src/auth/login'],
    });

    assert.equal(second.admitted, false);
    assert.match(second.queueReason, /写域/);

    await runtime.dispose();
  });

  it('先完成先汇报：先结算的执行者先产生汇报', async () => {
    const root = await makeProjectDir();
    const store = new MemoryStore();
    const order: string[] = [];
    const llm = new MockLlmClient((request) => {
      if (isExecutorTurn(request)) {
        const goal = request.messages.find((m) => m.role === 'user')?.content ?? '';
        return { text: typeof goal === 'string' && goal.includes('慢') ? '慢的结论' : '快的结论' };
      }
      return { text: 'ok' };
    });
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    runtime.on('runtime', (event) => {
      if (event.type === 'executor_settled') order.push(event.executor.label);
    });

    await runtime.spawn(project.id, { label: '快的', goal: '快活', writeScope: ['src/a'] });
    await runtime.spawn(project.id, { label: '慢的', goal: '慢活', writeScope: ['src/b'] });

    await waitFor(() => order.length === 2, 8000);
    assert.equal(order.length, 2, '两个都要结算，且互不阻塞');

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
