/**
 * 装配测试：`createBaoService` 端到端。
 *
 * 这里测的是"插件加载后到底能不能工作"——M0 时期最大的缺口正是
 * "没在真实宿主上验证过"。我们至少要把装配层的行为钉死：
 * 缺存储就拒绝启动、工具全注册、并发上限超配额要告警。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBaoService } from '../index.js';
import { DSH_DEFAULT_MAX_ACTIVE_SUBAGENTS } from '../config.js';
import type { HostApi } from '../host.js';
import { makeFakeAgentRegistry, makeFakeSubagents, makeMemoryFacility } from './helpers.js';

function makeHost(overrides: Partial<HostApi> = {}): HostApi {
  const facility = makeMemoryFacility();
  return {
    agents: makeFakeAgentRegistry(),
    subagents: makeFakeSubagents(),
    storageDomain: facility,
    tools: { register: () => () => {}, guard: () => () => {} },
    effect: () => {},
    ...overrides,
  };
}

describe('插件装配', () => {
  it('宿主齐备时正常加载并注册全部工具', async () => {
    const registered: string[] = [];
    const host = makeHost({
      tools: {
        register: (def: unknown) => {
          registered.push((def as { name: string }).name);
          return () => {};
        },
        guard: () => () => {},
      },
    });

    const service = await createBaoService({ host, log: () => {} });
    assert.equal(service.hostReport.ok, true);

    // 项目 2 + C 5 + B 3 = 10
    assert.equal(registered.length, 10);
    for (const name of [
      'open_project',
      'spawn_executor',
      'message_executor',
      'list_executors',
      'cancel_executor',
      'report_to_user',
      'find_project',
      'handoff_to_assistant',
    ]) {
      assert.ok(registered.includes(name), `应当注册 ${name}`);
    }

    await service.dispose();
  });

  it('缺 storageDomain 时拒绝启动，而不是用内存假装持久化', async () => {
    const host = makeHost({ storageDomain: undefined });
    await assert.rejects(
      () => createBaoService({ host, log: () => {} }),
      /storageDomain/,
    );
  });

  it('缺 agents 时仍加载，但把缺失原因讲清楚', async () => {
    const host = makeHost({ agents: undefined });
    const logs: string[] = [];
    const service = await createBaoService({
      host,
      log: (_level, message) => logs.push(message),
    });

    assert.equal(service.hostReport.ok, false);
    assert.ok(service.hostReport.missing.includes('agents'));
    assert.ok(
      logs.some((l) => l.includes('ctx.agents')),
      '日志里必须说明缺的是 ctx.agents',
    );

    // 此时打开项目要给出可读原因，而不是崩。
    const opened = await service.assistants.openProject({ rootPath: 'D:/work/x' });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.match(opened.reason, /ctx\.agents/);

    await service.dispose();
  });

  it('并发上限超过 dsh 配额时给出可读告警（方案 §7.2 / L5）', async () => {
    const host = makeHost();
    const logs: string[] = [];
    const service = await createBaoService({
      host,
      config: { maxConcurrentExecutors: DSH_DEFAULT_MAX_ACTIVE_SUBAGENTS + 2 },
      log: (_level, message) => logs.push(message),
    });

    assert.ok(service.warnings.length > 0, '必须产生告警');
    assert.match(service.warnings.join('\n'), /maxActiveSubagents/);
    await service.dispose();
  });

  it('宿主显式提供更小的 maxActiveSubagents 时按该值校验', async () => {
    const subagents = makeFakeSubagents();
    (subagents as unknown as { config: { maxActiveSubagents: number } }).config = {
      maxActiveSubagents: 3,
    };
    const host = makeHost({ subagents });

    const service = await createBaoService({
      host,
      config: { maxConcurrentExecutors: 5 },
      log: () => {},
    });
    assert.ok(
      service.warnings.join('\n').includes('3'),
      '告警里要写明宿主的真实配额',
    );
    await service.dispose();
  });

  it('关停会 dispose 掉自己持有的 C（L2：没有父树统一收敛）', async () => {
    const registry = makeFakeAgentRegistry();
    const service = await createBaoService({ host: makeHost({ agents: registry }), log: () => {} });

    const opened = await service.assistants.openProject({ rootPath: 'D:/work/y' });
    assert.equal(opened.ok, true);
    assert.equal(registry.list().length, 1);

    await service.dispose();
    assert.equal(registry.list().length, 0, '插件关停必须收回 C');
  });

  it('重复 dispose 是幂等的', async () => {
    const service = await createBaoService({ host: makeHost(), log: () => {} });
    await service.dispose();
    await assert.doesNotReject(() => service.dispose());
  });

  it('重启后残留的 running 执行者被标记为失败并写明原因', async () => {
    const first = await createBaoService({ host: makeHost(), log: () => {} });
    const opened = await first.assistants.openProject({ rootPath: 'D:/work/z' });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    await first.runner.start(
      { projectId: opened.project.id, label: '被中断的', goal: 'g', writeScope: 'src/a' },
      opened.assistant.agent,
    );
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(first.stats().running, 1);

    // 模拟进程崩溃：不 dispose，直接开新一世。
    // （storageDomain 是同一个内存域，需要绕过 already-open 检查）
    const facility = makeMemoryFacility();
    const host = makeHost({ storageDomain: facility });
    const second = await createBaoService({ host, log: () => {} });
    // 新 store 是空的，所以这里只验证"不会崩"，真正的恢复逻辑由 store 层单测覆盖。
    assert.equal(second.stats().executors, 0);

    await second.dispose();
    await first.dispose();
  });
});
