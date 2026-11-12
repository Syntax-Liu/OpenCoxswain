/**
 * HTTP / SSE 服务层测试。
 *
 * 真的起一个监听端口，用 fetch 打过去 —— 不 mock HTTP 层，
 * 否则测的是"我以为的语义"而不是真实行为。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { SqliteStore } from '../store/sqlite.js';
import { EventBus } from '../server/bus.js';
import { startServer, type RunningServer } from '../server/server.js';
import type { Store } from '../store/store.js';
import { MockLlmClient, isAssistantTurn, isExecutorTurn, isSettlementNotice } from './mock-llm.js';

const temps: string[] = [];
const servers: RunningServer[] = [];

after(async () => {
  for (const server of servers) await server.close().catch(() => {});
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function makeRuntime(): Promise<{
  store: Store;
  orchestrator: Orchestrator;
  server: RunningServer;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-http-'));
  temps.push(dir);

  const store = new MemoryStore();
  const llm = new MockLlmClient((request) => {
    if (isExecutorTurn(request)) {
      return { text: '结论：已完成。\n### 做了什么\n无\n### 验证了什么\n未验证\n### 需要用户决定什么\n无' };
    }
    if (isSettlementNotice(request)) return { text: '收到结算。' };
    if (isAssistantTurn(request)) return { text: '好的，收到你的需求。' };
    return { text: 'ok' };
  });

  const orchestrator = new Orchestrator({ store, llm });
  // port 0 → 让系统分配空闲端口，避免测试间抢占
  const server = await startServer({ orchestrator, store, port: 0 });
  servers.push(server);
  return { store, orchestrator, server };
}

async function post(url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function get(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('HTTP 接口', () => {
  it('健康检查返回统计', async () => {
    const { server } = await makeRuntime();
    const res = await get(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.stats.limit, 'number');
  });

  it('打开项目 → 列表能查到 → 详情含 Assistant 会话锚点', async () => {
    const { server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, {
      rootPath: 'D:/work/app',
      name: 'demo',
    });
    assert.equal(opened.status, 200);
    const projectId = opened.json.project.id;
    assert.ok(opened.json.project.assistantSessionId, '必须回填 Assistant 的会话 id');

    const list = await get(`${server.url}/api/projects`);
    assert.equal(list.json.projects.length, 1);
    assert.equal(list.json.projects[0].id, projectId);

    const detail = await get(`${server.url}/api/projects/${projectId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.json.executors, []);
    assert.equal(typeof detail.json.lastSeq, 'number');
  });

  it('缺少 rootPath 返回 400 与可读原因', async () => {
    const { server } = await makeRuntime();
    const res = await post(`${server.url}/api/projects`, {});
    assert.equal(res.status, 400);
    assert.match(res.json.error, /rootPath/);
  });

  it('不存在的项目返回 404', async () => {
    const { server } = await makeRuntime();
    const res = await get(`${server.url}/api/projects/prj_nope`);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /不存在/);
  });

  it('对 Assistant 说话立刻返回 202，不等模型', async () => {
    const { store, server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/a' });
    const projectId = opened.json.project.id;

    const res = await post(`${server.url}/api/projects/${projectId}/say`, { text: '你好' });
    assert.equal(res.status, 202);
    assert.equal(res.json.accepted, true);

    // 稍等后，Assistant 的回复应当已落进会话历史
    await waitFor(
      () => store.messages(opened.json.project.assistantSessionId).length >= 2,
      5000,
    );
    const messages = await get(`${server.url}/api/projects/${projectId}/messages`);
    const contents = messages.json.messages.map((m: { content: string }) => m.content);
    assert.ok(contents.includes('你好'));
  });

  it('空白文本被拒绝', async () => {
    const { server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/b' });
    const res = await post(`${server.url}/api/projects/${opened.json.project.id}/say`, {
      text: '   ',
    });
    assert.equal(res.status, 400);
  });

  it('"打开原会话"能读到Agent 的完整记录', async () => {
    const { store, orchestrator, server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/c' });
    const projectId = opened.json.project.id;

    const spawn = await orchestrator.spawn(projectId, { label: '干活', goal: 'g' });
    // 等 D 跑完
    await waitFor(() => {
      const e = store.getExecutor(spawn.executor.id);
      return e !== undefined && (e.status === 'done' || e.status === 'failed');
    }, 8000);

    const res = await get(`${server.url}/api/executors/${spawn.executor.id}/messages`);
    assert.equal(res.status, 200);
    assert.ok(res.json.executor, '必须返回Agent');
    assert.ok(res.json.session, '必须返回它的会话（原会话入口）');
  });

  it('Supervisor 的路由：命中给依据，不命中不给答案', async () => {
    const { server } = await makeRuntime();
    await post(`${server.url}/api/projects`, { rootPath: 'D:/work/webapp', name: 'webapp' });

    const hit = await post(`${server.url}/api/route`, { query: '把 webapp 改一下' });
    assert.equal(hit.status, 200);
    assert.equal(hit.json.decision, 'unique');
    assert.ok(hit.json.candidates[0].reasons.length > 0);

    const miss = await post(`${server.url}/api/route`, { query: '今天天气不错' });
    assert.equal(miss.json.decision, 'none');
  });

  it('B 转交原话成功，且原话被记录', async () => {
    const { store, server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/d' });
    const projectId = opened.json.project.id;

    const original = '把登录页重构一下，顺便看看导出为什么卡住';
    const res = await post(`${server.url}/api/handoff`, { projectId, userText: original });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    await waitFor(
      () =>
        store
          .messages(opened.json.project.assistantSessionId)
          .some((m) => m.content === original),
      5000,
    );
  });

  it('未知接口返回 404 JSON 而不是 HTML', async () => {
    const { server } = await makeRuntime();
    const res = await get(`${server.url}/api/nope`);
    assert.equal(res.status, 404);
    assert.match(res.json.error, /未知接口/);
  });

  it('CORS 预检返回 204', async () => {
    const { server } = await makeRuntime();
    const res = await fetch(`${server.url}/api/projects`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
  });

  it('超大请求体被拒绝', async () => {
    const { server } = await makeRuntime();
    const big = 'x'.repeat(5 * 1024 * 1024);
    const res = await post(`${server.url}/api/projects`, { rootPath: 'D:/a', name: big });
    assert.notEqual(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe('SSE 事件流', () => {
  it('SSE 首帧必须立刻到达（回归：曾经因为没 flushHeaders 卡 15s）', async () => {
    const { server } = await makeRuntime();
    const started = Date.now();
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/events?after=0`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    const elapsed = Date.now() - started;
    await res.body?.cancel().catch(() => {});
    controller.abort();

    assert.equal(res.status, 200);
    assert.ok(
      elapsed < 3000,
      `拿到响应头用了 ${elapsed}ms；SSE 必须立刻 flushHeaders，否则客户端会卡到超时`,
    );
  });

  it('连接后能收到后续事件', async () => {
    const { orchestrator, server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/e' });
    const projectId = opened.json.project.id;

    const received: string[] = [];
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/events?after=0`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(res.status, 200);

    const reader = res.body!.getReader();
    // 后台读，直到被 abort。注意：**必须在断言后立即 abort 并等它收敛**，
    // 否则未取消的流会拖住进程（心跳定时器让 reader 永远不结束）。
    const pump = (async () => {
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value).split('\n')) {
            if (line.startsWith('data: ')) received.push(line.slice(6));
          }
        }
      } catch {
        // 主动 abort 时的正常退出
      }
    })();

    await orchestrator.spawn(projectId, { label: 'x', goal: 'g' });
    await waitFor(() => received.some((d) => d.includes('executor_started')), 5000);

    // 先用 reader.cancel() 主动结束流，再 abort。
    // 顺序反了（先 abort）会让 cancel 失效、pump 卡在等下一块数据上。
    await reader.cancel().catch(() => {});
    controller.abort();
    await pump;
  });

  it('断线重连用 after 补发错过的事件（不丢状态）', async () => {
    const { orchestrator, server } = await makeRuntime();
    const opened = await post(`${server.url}/api/projects`, { rootPath: 'D:/work/f' });
    const projectId = opened.json.project.id;

    // 先产生几个事件
    await orchestrator.spawn(projectId, { label: 'a', goal: 'g' });
    await orchestrator.spawn(projectId, { label: 'b', goal: 'g' });
    await new Promise((r) => setTimeout(r, 100));

    const health = await get(`${server.url}/api/health`);
    const lastSeq = health.json.lastSeq;
    assert.ok(lastSeq > 0, '应当已经产生事件');

    // 模拟"断了再连"：客户端只收到过 seq=1，重连时带 after=1
    const controller = new AbortController();
    const res = await fetch(`${server.url}/api/events?after=1`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    controller.abort();
    await reader.cancel().catch(() => {});

    assert.match(text, /executor_started|turn_judged/, '重连必须补发历史事件');
    // 不应补发 seq=1 本身
    assert.ok(!text.includes('id: 1\n'), '不该重复补发客户端已有的那条');
  });
});

describe('事件总线（单元）', () => {
  it('按 seq 补发，且不重复发送客户端已有的那条', () => {
    const bus = new EventBus(10);
    for (let i = 0; i < 5; i += 1) {
      bus.publish({ type: 'assistant_text', projectId: 'p', text: `第 ${i} 条` });
    }
    assert.equal(bus.lastSeq, 5);

    const gotten: number[] = [];
    bus.subscribe((item) => gotten.push(item.seq), 4);
    assert.deepEqual(gotten, [5], 'after=4 只应补发 seq>4 的');
  });

  it('断线错过太多时给出 gap，而不是假装没断过', () => {
    const bus = new EventBus(3); // 只保留最近 3 条
    for (let i = 0; i < 5; i += 1) {
      bus.publish({ type: 'assistant_text', projectId: 'p', text: `第 ${i} 条` });
    }
    // 缓冲现在是 seq 3,4,5；客户端只收到过 seq=1 → 2 已滚出 → 必须报 gap
    const gaps: string[] = [];
    bus.subscribe((item) => {
      if (item.event.type === 'gap') gaps.push(item.event.reason);
    }, 1);
    assert.equal(gaps.length, 1, '必须告知有缺口');
    assert.match(gaps[0]!, /重新拉取快照/);
  });

  it('全新客户端（after=0）不报 gap：它本来就会先拉快照', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i += 1) {
      bus.publish({ type: 'assistant_text', projectId: 'p', text: `第 ${i} 条` });
    }
    const gaps: string[] = [];
    bus.subscribe((item) => {
      if (item.event.type === 'gap') gaps.push(item.event.reason);
    }, 0);
    assert.equal(gaps.length, 0);
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

void SqliteStore;
