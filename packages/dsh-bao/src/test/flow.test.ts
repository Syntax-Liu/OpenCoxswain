/**
 * 主推流程端到端测试：A → C → D → C 汇报。
 *
 * 对应用户设想的完整闭环：
 * > 用户进入软件 → 新建项目 → 对 C 发任务 → C 调 D →
 * > 某个 D 完成 → C 向用户汇报（谁先完成先报谁）→ 继续循环
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AssistantManager } from '../assistant/lifecycle.js';
import { buildAssistantTools } from '../assistant/tools.js';
import { buildGlobalTools } from '../global/tools.js';
import { ExecutorRunner } from '../executor/runner.js';
import { Gate } from '../executor/gate.js';
import { Reporter } from '../executor/reporter.js';
import { resolveConfig } from '../config.js';
import { createReport, getProject, listReports, listTurns, openBaoStore } from '../store.js';
import type { HostApi } from '../host.js';
import { makeFakeAgentRegistry, makeFakeSubagents, makeMemoryFacility } from './helpers.js';

async function setup() {
  const facility = makeMemoryFacility();
  const store = await openBaoStore(facility);
  const host: HostApi = {
    agents: makeFakeAgentRegistry(),
    subagents: makeFakeSubagents(),
    storageDomain: facility,
    tools: { register: () => () => {}, guard: () => () => {} },
    effect: () => {},
  };
  const { config } = resolveConfig({ reportDebounceMs: 0, maxConcurrentExecutors: 5 });
  const log = () => {};

  const assistants = new AssistantManager({ store, config, host, log });
  const gate = new Gate(config.maxConcurrentExecutors);
  const reporter = new Reporter({
    store,
    config,
    log,
    assistantOf: (projectId) => assistants.getAssistant(projectId),
  });
  const runner = new ExecutorRunner({
    store,
    gate,
    config,
    host,
    log,
    onSettled: (executor, result) => reporter.onSettled(executor, result),
  });

  return { store, host, config, assistants, gate, reporter, runner };
}

const ROOT = 'D:/work/app';

describe('主推流程：用户 ↔ C ↔ D', () => {
  it('新建项目会建出常驻 C，并记录 assistantSessionId（锚点）', async () => {
    const { store, assistants } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const project = getProject(store, opened.project.id);
    assert.ok(project);
    assert.ok(project.assistantSessionId, 'assistantSessionId 必须被回填');
    assert.equal(opened.assistant.sessionId, project.assistantSessionId);
    // 根 Agent：拿得到活 Agent。
    assert.ok(assistants.getAssistant(project.id));
  });

  it('重复打开同一路径复用同一个 C（不重复建）', async () => {
    const { store, assistants } = await setup();
    const first = await assistants.openProject({ rootPath: ROOT });
    const second = await assistants.openProject({ rootPath: 'D:\\Work\\App\\' });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.project.id, second.project.id);
    assert.equal(first.assistant.sessionId, second.assistant.sessionId);
    assert.equal([...store.projects.entries()].length, 1);
  });

  it('C 能派 D，且派活立刻返回（不阻塞）', async () => {
    const { host, assistants, runner } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const subagents = host.subagents as ReturnType<typeof makeFakeSubagents>;
    const outcome = await runner.start(
      { projectId: opened.project.id, label: '重构登录页', goal: '把登录页拆成组件', writeScope: 'src/auth' },
      opened.assistant.agent,
    );

    assert.equal(outcome.admitted, true);
    assert.equal(outcome.executor.status, 'starting');
    // 派活立刻返回：此刻插件内部的派活链路还在后台跑。
    assert.equal(subagents.started.length, 0, 'start() 不能阻塞等 activation');
    await flush();
    // 后台链路跑起来后才真正起了 activation，但结果还没结算。
    assert.equal(subagents.started.length, 1);
    assert.equal(subagents.started[0]!.spec.delivery, 'parent');
    assert.equal(subagents.started[0]!.spec.request.cwd, normalizeRoot(ROOT));
  });

  it('两个写域不同的 D 可以并行跑', async () => {
    const { assistants, runner, gate } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;

    await runner.start({ projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/auth' }, c);
    await runner.start({ projectId: opened.project.id, label: 'B', goal: 'g', writeScope: 'src/export' }, c);

    await flush();
    // 两个都进了闸门（并行）。
    assert.equal(gate.stats().running, 2);
    assert.equal(gate.stats().queued, 0);
  });

  it('写域相交的 D 排队而不是同时跑（L4 兜底）', async () => {
    const { assistants, runner, gate } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;

    await runner.start({ projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/auth' }, c);
    const second = await runner.start(
      { projectId: opened.project.id, label: 'B', goal: 'g', writeScope: 'src/auth/login' },
      c,
    );

    await flush();
    assert.equal(second.admitted, false);
    assert.match(second.queueReason, /写域/);
    assert.equal(gate.stats().running, 1);
    assert.equal(gate.stats().queued, 1);
  });

  it('声明不了写域的 D 与所有写任务串行', async () => {
    const { assistants, runner, gate } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;

    await runner.start({ projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/auth' }, c);
    const second = await runner.start({ projectId: opened.project.id, label: 'B', goal: 'g' }, c);
    await flush();
    assert.equal(second.admitted, false);
    assert.equal(gate.stats().queued, 1);
  });

  it('谁先完成先汇报：先结算的 D 先产生汇报，不等兄弟（D4）', async () => {
    const { host, store, assistants, runner } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;
    const subagents = host.subagents as ReturnType<typeof makeFakeSubagents>;

    const a = await runner.start(
      { projectId: opened.project.id, label: 'D1-快', goal: 'g', writeScope: 'src/a' },
      c,
    );
    const b = await runner.start(
      { projectId: opened.project.id, label: 'D2-慢', goal: 'g', writeScope: 'src/b' },
      c,
    );
    await flush();

    // D2 先结算（尽管它创建得晚）—— 验证"互不影响"。
    subagents.started[1]!.settle({
      output: [{ type: 'text', text: 'D2 的结论' }],
      stopReason: 'completed',
    });
    await flush();

    const reportsAfterFirst = listReports(store, opened.project.id);
    assert.equal(reportsAfterFirst.length, 1, '应当只汇报了先完成的那一个');
    assert.match(reportsAfterFirst[0]!.body, /D2 的结论/);
    assert.equal(reportsAfterFirst[0]!.executorId, b.executor.id);

    // D1 后结算。
    subagents.started[0]!.settle({
      output: [{ type: 'text', text: 'D1 的结论' }],
      stopReason: 'completed',
    });
    await flush();

    const all = listReports(store, opened.project.id);
    assert.equal(all.length, 2);
    assert.equal(all[1]!.executorId, a.executor.id);
  });

  it('结算后槽位释放，排队的 D 得以进入', async () => {
    const { host, assistants, runner, gate } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;
    const subagents = host.subagents as ReturnType<typeof makeFakeSubagents>;

    await runner.start({ projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/auth' }, c);
    await runner.start({ projectId: opened.project.id, label: 'B', goal: 'g', writeScope: 'src/auth/x' }, c);
    await flush();
    assert.equal(gate.stats().queued, 1);

    subagents.started[0]!.settle({ output: [], stopReason: 'completed' });
    await flush();

    assert.equal(gate.stats().queued, 0);
    assert.equal(gate.stats().running, 1, '排队的 B 应当补位');
    assert.equal(subagents.started.length, 2);
  });

  it('D 失败时按卡点分类落库，环境问题标为需用户处理', async () => {
    const { host, store, assistants, runner } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const c = opened.assistant.agent;
    const subagents = host.subagents as ReturnType<typeof makeFakeSubagents>;

    const outcome = await runner.start(
      { projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/a' },
      c,
    );
    await flush();
    subagents.started[0]!.settle({
      output: [],
      stopReason: 'error',
      diagnostic: 'EPERM permission denied',
    });
    await flush();

    const reports = listReports(store, opened.project.id);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.needsUser, 1);
    assert.ok(
      (await runner.list(opened.project.id)).find((e) => e.id === outcome.executor.id)
        ?.blockedReason?.includes('环境问题'),
    );
  });
});

describe('C 的工具', () => {
  it('spawn_executor 记录冲突判定留痕（TurnRow.judged）', async () => {
    const { store, assistants, runner, gate, reporter } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const created: string[] = [];
    const tools = buildAssistantTools({
      store,
      gate,
      runner,
      log: () => {},
      reportToUser: async () => {
        created.push('reported');
      },
    });
    const spawn = tools.find((t) => t.name === 'spawn_executor')!;

    // 模拟工具执行上下文里的调用方 C。
    const exec = { agent: opened.assistant.agent };
    await spawn.execute(
      { label: '重构登录', goal: '拆组件', writeScope: ['src/auth'], judged: 'new' },
      exec,
    );

    const turns = listTurns(store, opened.project.id);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.judged, 'new');
    assert.ok(turns[0]!.executorId, '要记下是哪个 D');
    void reporter;
  });

  it('非 C 会话调用 spawn_executor 会被拒绝并说明原因', async () => {
    const { store, assistants, runner, gate } = await setup();
    const tools = buildAssistantTools({
      store,
      gate,
      runner,
      log: () => {},
      reportToUser: async () => {},
    });
    const spawn = tools.find((t) => t.name === 'spawn_executor')!;
    await assert.rejects(
      () => spawn.execute({ label: 'x', goal: 'y' }, { agent: { id: 'not-a-c', session: { id: 'nope' } } }),
      /项目助理/,
    );
    void assistants;
  });
});

describe('B 的职责边界（方案 §7.1 D1）', () => {
  it('B 只有三个工具，不给派活能力', async () => {
    const { store, assistants } = await setup();
    const tools = buildGlobalTools({
      store,
      log: () => {},
      assistantOf: (id) => assistants.getAssistant(id),
    });
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['find_project', 'handoff_to_assistant', 'list_projects'],
    );
    assert.ok(!tools.some((t) => t.name.includes('spawn') || t.name.includes('dispatch')));
  });

  it('转交的是原话，不做任何加工', async () => {
    const { store, host, assistants } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const registry = host.agents as ReturnType<typeof makeFakeAgentRegistry>;
    const tools = buildGlobalTools({
      store,
      log: () => {},
      assistantOf: (id) => assistants.getAssistant(id),
    });
    const handoff = tools.find((t) => t.name === 'handoff_to_assistant')!;

    const original = '把登录页重构一下，顺便看看导出为什么卡住';
    const result = (await handoff.execute(
      { projectId: opened.project.id, userText: original },
      {},
    )) as { ok: boolean };
    assert.equal(result.ok, true);

    const delivery = registry.deliveries.at(-1);
    assert.ok(delivery);
    const message = delivery.message as { content: Array<{ text: string }> };
    assert.equal(message.content[0]!.text, original, '必须是逐字原话');
  });

  it('C 未加载时如实回报失败，而不是假装成功', async () => {
    const { store, host, assistants } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    // 模拟重启：注册表清空，C 不在场。
    (host.agents as ReturnType<typeof makeFakeAgentRegistry>).restart();

    const tools = buildGlobalTools({
      store,
      log: () => {},
      assistantOf: (id) => assistants.getAssistant(id),
    });
    const handoff = tools.find((t) => t.name === 'handoff_to_assistant')!;
    const result = (await handoff.execute(
      { projectId: opened.project.id, userText: '推进一下' },
      {},
    )) as { ok: boolean; reason: string };

    assert.equal(result.ok, false);
    assert.match(result.reason, /未加载/);
  });

  it('依据不足时 find_project 不给唯一答案', async () => {
    const { store, assistants } = await setup();
    await assistants.openProject({ rootPath: 'D:/work/alpha', name: 'alpha' });
    await assistants.openProject({ rootPath: 'D:/work/beta', name: 'beta' });

    const tools = buildGlobalTools({
      store,
      log: () => {},
      assistantOf: (id) => assistants.getAssistant(id),
    });
    const find = tools.find((t) => t.name === 'find_project')!;
    const result = (await find.execute({ query: '随便说点什么' }, {})) as { decision: string };
    assert.equal(result.decision, 'none');
  });
});

describe('重启恢复（D5 完整恢复）', () => {
  it('重启后打开项目会 resume 原会话，取回同一个 C', async () => {
    const { store, host, assistants } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const sessionId = opened.assistant.sessionId;

    const registry = host.agents as ReturnType<typeof makeFakeAgentRegistry>;
    registry.seedPersisted(sessionId);
    registry.restart();
    assert.equal(registry.get(sessionId), undefined, '重启后取不到是常态');

    // 新一世的 manager（模拟插件重新加载）。
    const { config } = resolveConfig({});
    const revived = new AssistantManager({ store, config, host, log: () => {} });
    const reopened = await revived.openProject({ rootPath: ROOT });

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.equal(reopened.assistant.sessionId, sessionId, '应当恢复同一个会话，而不是新建');
    assert.ok(revived.getAssistant(reopened.project.id));
  });

  it('恢复失败时新建 C，并如实记录降级', async () => {
    const { store, host, assistants } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const registry = host.agents as ReturnType<typeof makeFakeAgentRegistry>;
    registry.seedPersisted(opened.assistant.sessionId, { resumeFails: true });
    registry.restart();

    const { config } = resolveConfig({});
    const revived = new AssistantManager({ store, config, host, log: () => {} });
    const reopened = await revived.openProject({ rootPath: ROOT });

    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.notEqual(reopened.assistant.sessionId, opened.assistant.sessionId, '恢复失败才新建');
  });
});

describe('汇报落库（C 不在场也不丢事实）', () => {
  it('reporter 在 C 缺失时保留待汇报项', async () => {
    const { store, host, config, assistants, reporter, runner } = await setup();
    const opened = await assistants.openProject({ rootPath: ROOT });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const subagents = host.subagents as ReturnType<typeof makeFakeSubagents>;

    await runner.start(
      { projectId: opened.project.id, label: 'A', goal: 'g', writeScope: 'src/a' },
      opened.assistant.agent,
    );
    await flush();
    // C 消失（重启）。
    (host.agents as ReturnType<typeof makeFakeAgentRegistry>).restart();
    subagents.started[0]!.settle({ output: [{ type: 'text', text: '结论' }], stopReason: 'completed' });
    await flush();

    // 事实已落库
    assert.equal(listReports(store, opened.project.id).length, 1);
    // 且留在待汇报队列里等 C 回来
    assert.equal(reporter.pendingCount(opened.project.id), 1);
    void config;
  });
});

// ---------------------------------------------------------------------------

/** 等所有 microtask + 定时器跑完（reportDebounceMs=0）。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function normalizeRoot(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

void createReport;
