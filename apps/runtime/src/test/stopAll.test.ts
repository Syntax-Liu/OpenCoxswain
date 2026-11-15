/**
 * 用户叫停 = 停掉这一切。
 *
 * ## 为什么需要这一条
 *
 * 产品上有意设计了「连发不打断」：用户不需要打断 Assistant，只说最新的想法，
 * 消息排队，当前这轮跑完再被看到。这是**故意的**，不是缺陷。
 *
 * 但「叫停」是另一件事。用户说停，意思是**什么活都别干了**——
 * 不只是 Assistant 别再说话，而是它派出去的 Agent 全部停下。
 *
 * ## 曾经的真实缺陷
 *
 * `POST /api/projects/:id/stop` 只调用了 `assistant.stop()`（中止 Assistant 当前那一轮），
 * **一个 Agent 都没停**。界面上点"停止"之后，Agent 还在改文件、还在烧 token。
 * 而 `orchestrator.cancel()` 本来就能取消单个 Agent——它从来没被这条路用过。
 *
 * 所以这两个测试锁死一件事：**停止必须级联，而且级联后的状态必须是诚实的终态。**
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-stop-'));
  temps.push(dir);
  return dir;
}

/** 轮询直到条件成立，超时就失败（带清楚的原因）。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`超时：${what}`);
}

describe('用户叫停要级联到所有 Agent', () => {
  it('stopAll 把所有在跑的 Agent 一并取消，状态是 cancelled 而不是假装 done', async () => {
    const root = await projectDir();
    const store = new MemoryStore();

    // Agent 卡在一个永不返回的轮次里，模拟"正在跑但很慢"的真实情况。
    // Assistant 的轮次立刻返回，避免它自己占着 inbox。
    let releaseExecutors: () => void = () => {};
    const executorBlocked = new Promise<void>((resolve) => {
      releaseExecutors = resolve;
    });

    const llm = new MockLlmClient(async (request) => {
      if (isExecutorTurn(request)) {
        await executorBlocked;
        return { text: '结论：做完了。' };
      }
      return { text: '收到，我派两个 Agent 去做。' };
    });

    const runtime = new Orchestrator({ store, llm, maxConcurrentExecutors: 5 });
    const { project } = await runtime.openProject({ rootPath: root });

    const a = await runtime.spawn(project.id, {
      label: '改登录页',
      goal: '把登录页拆成组件',
      writeScope: ['src/auth'],
    });
    const b = await runtime.spawn(project.id, {
      label: '补测试',
      goal: '给登录页补测试',
      writeScope: ['src/auth/tests'],
    });

    // 两个都真的在跑（没有一个已经结束）。
    await waitFor('两个 Agent 进入运行态', () => {
      const sa = store.getExecutor(a.executor.id)?.status;
      const sb = store.getExecutor(b.executor.id)?.status;
      return (sa === 'running' || sa === 'starting') && (sb === 'running' || sb === 'starting');
    });

    const result = await runtime.stopAll(project.id);

    // 两个都被取消
    assert.deepEqual(
      [...result.cancelled].sort(),
      [a.executor.id, b.executor.id].sort(),
      '在跑的两个 Agent 都应当出现在 cancelled 里',
    );
    assert.equal(store.getExecutor(a.executor.id)?.status, 'cancelled');
    assert.equal(store.getExecutor(b.executor.id)?.status, 'cancelled');

    // **不能**被记成 done：任务根本没做完。
    assert.notEqual(store.getExecutor(a.executor.id)?.status, 'done');

    releaseExecutors();
    await runtime.dispose();
  });

  it('停止之后，还在排队的 Agent 也一起取消（不留下偷偷开跑的任务）', async () => {
    const root = await projectDir();
    const store = new MemoryStore();

    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const llm = new MockLlmClient(async (request) => {
      if (isExecutorTurn(request)) {
        await firstBlocked;
        return { text: '结论：做完了。' };
      }
      return { text: '收到。' };
    });

    // 并发上限 1：第二个只能排队。
    const runtime = new Orchestrator({ store, llm, maxConcurrentExecutors: 1 });
    const { project } = await runtime.openProject({ rootPath: root });

    const first = await runtime.spawn(project.id, {
      label: '第一个',
      goal: 'g1',
      writeScope: ['src'],
    });
    const second = await runtime.spawn(project.id, {
      label: '第二个',
      goal: 'g2',
      writeScope: ['src'],
    });

    assert.equal(first.admitted, true);
    assert.equal(second.admitted, false, '并发上限 1 时第二个应当排队');

    await runtime.stopAll(project.id);

    // 排队的那个不能还是"排队中"，否则停止之后它还会自己开跑。
    assert.equal(store.getExecutor(second.executor.id)?.status, 'cancelled');
    assert.equal(store.getExecutor(first.executor.id)?.status, 'cancelled');

    releaseFirst();
    await runtime.dispose();
  });
});
