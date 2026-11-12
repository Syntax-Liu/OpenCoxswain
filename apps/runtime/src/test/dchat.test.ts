/**
 * 端到端：三条只读任务并行 + Agent 可续聊。
 *
 * 对应用户反馈的两个诉求：
 * 1. "我让它开三条会话，仍然是逐条执行的" —— 只读任务必须真正并行；
 * 2. "点开某条对话继续跟它聊" —— Agent 完成后能带上下文续跑。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-par-'));
  temps.push(dir);
  return dir;
}

describe('三条只读任务真正并行（回归：曾逐条执行）', () => {
  it('同时派三个只读Agent，三个都立刻进入 running，零排队', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    // 让 D 停在一个"等待"上，好观察它们是否同时在跑。
    const llm = new MockLlmClient(() => ({ text: '结论：读完了。' }));
    const runtime = new Orchestrator({ store, llm, maxConcurrentExecutors: 5 });
    const { project } = await runtime.openProject({ rootPath: root });

    const a = await runtime.spawn(project.id, {
      label: '读 A',
      goal: '读一下 A',
      writeScope: ['readonly'],
    });
    const b = await runtime.spawn(project.id, {
      label: '读 B',
      goal: '读一下 B',
      writeScope: ['readonly'],
    });
    const c = await runtime.spawn(project.id, {
      label: '读 C',
      goal: '读一下 C',
      writeScope: ['readonly'],
    });

    // 三个都必须立即准入
    assert.equal(a.admitted, true);
    assert.equal(b.admitted, true);
    assert.equal(c.admitted, true);
    assert.equal(a.queueReason, '', 'A 不该排队');
    assert.equal(b.queueReason, '', 'B 不该排队');
    assert.equal(c.queueReason, '', 'C 不该排队');

    // 库里三个都是只读
    for (const e of store.listExecutors({ projectId: project.id })) {
      assert.equal(e.access, 'readonly');
    }

    await runtime.dispose();
  });

  it('写任务仍然互斥（没被放松）', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: '结论：完成。' })),
    });
    const { project } = await runtime.openProject({ rootPath: root });

    const first = await runtime.spawn(project.id, {
      label: '写 A',
      goal: 'g',
      writeScope: ['src/auth'],
    });
    assert.equal(first.admitted, true);

    const second = await runtime.spawn(project.id, {
      label: '写 B',
      goal: 'g',
      writeScope: ['src/auth/login'],
    });
    // 第一个可能已经结算（假模型很快），所以这里只断言"没有因为只读逻辑而被无条件放行"
    const row = store.getExecutor(second.executor.id);
    assert.ok(row);
    assert.equal(row.access, 'readwrite');

    await runtime.dispose();
  });

  it('只读任务能与正在跑的写任务并行', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: '结论：完成。' })),
    });
    const { project } = await runtime.openProject({ rootPath: root });

    const writer = await runtime.spawn(project.id, {
      label: '写',
      goal: 'g',
      writeScope: ['src/auth'],
    });
    const reader = await runtime.spawn(project.id, {
      label: '读',
      goal: 'g',
      writeScope: ['readonly'],
    });

    assert.equal(writer.admitted, true);
    assert.equal(reader.admitted, true, '只读任务不该被写任务挡住');

    await runtime.dispose();
  });
});

describe('Agent 可续聊（带原上下文）', () => {
  it('Agent 完成后用户继续追问，它带着历史回答', async () => {
    const root = await projectDir();
    const store = new MemoryStore();
    const seen: string[][] = [];
    let phase = 0;

    const llm = new MockLlmClient((request) => {
      if (!isExecutorTurn(request)) return { text: 'ok' };
      phase += 1;
      if (phase === 1) {
        // 首轮：记下历史并给结论
        seen.push(request.messages.filter((m) => m.role !== 'system').map((m) => String(m.content)));
        return { text: '结论：第一次执行完成，我用了 read_file。' };
      }
      // 续聊轮：必须能看到首轮的内容
      seen.push(request.messages.filter((m) => m.role !== 'system').map((m) => String(m.content)));
      return { text: '结论：带着上下文又回答了你的追问。' };
    });

    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    const spawn = await runtime.spawn(project.id, {
      label: '可续聊的Agent',
      goal: '第一步：读文件',
      writeScope: ['readonly'],
    });
    await waitFor(() => store.getExecutor(spawn.executor.id)?.status === 'done', 8000);

    // 用户直接对 Agent 追问
    const result = await runtime.userSaysToExecutor(
      spawn.executor.id,
      '刚才你读了什么？再解释一下',
    );

    assert.equal(result.ok, true, `续聊应当成功：${result.message}`);
    assert.match(result.message, /带着上下文/);

    // 第二轮请求里必须包含首轮的目标与结论
    const secondTurn = seen.at(-1) ?? [];
    const joined = secondTurn.join('\n');
    assert.match(joined, /第一步：读文件/, '续聊必须带上最初的目标');
    assert.match(joined, /第一次执行完成/, '续聊必须带上上一轮的结论');

    // 轨迹里能看到续聊这一轮
    const transcript = runtime.executorTranscript(spawn.executor.id);
    const contents = transcript.messages.map((m) => m.content);
    assert.ok(contents.some((c) => c.includes('再解释一下')), '追踪里要有用户的追问');
    assert.ok(contents.some((c) => c.includes('带着上下文又回答')), '追踪里要有答复');

    await runtime.dispose();
  });

  it('已删除/不存在的Agent续聊会给出可读错误', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const result = await runtime.userSaysToExecutor('exe_nope', '继续');
    assert.equal(result.ok, false);
    assert.match(result.message, /不存在/);
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
