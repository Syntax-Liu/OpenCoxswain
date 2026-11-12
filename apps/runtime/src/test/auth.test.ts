/**
 * API 鉴权的端到端测试（真实 HTTP 请求）。
 *
 * 修复的问题：原来 CORS 是 `*` 且完全无鉴权，
 * **任意网页都能跨源读本地 API**——项目路径、会话、审批内容，
 * 甚至派活执行命令。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { startServer, type RunningServer } from '../server/server.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
const servers: RunningServer[] = [];
const runtimes: Orchestrator[] = [];

after(async () => {
  for (const server of servers) await server.close().catch(() => {});
  for (const runtime of runtimes) await runtime.dispose().catch(() => {});
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function setup(): Promise<{ base: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'ocx-auth-'));
  temps.push(root);

  const runtime = new Orchestrator({
    store: new MemoryStore(),
    llm: new MockLlmClient(() => ({ text: 'ok' })),
  });
  runtimes.push(runtime);
  const { project } = await runtime.openProject({ rootPath: root });
  void project;

  const server = await startServer({
    orchestrator: runtime,
    store: new MemoryStore(),
    port: 0,
    token: TOKEN,
  });
  servers.push(server);
  return { base: server.url };
}

describe('API 鉴权（真实 HTTP）', () => {
  it('**不带令牌 → 401**', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/projects`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /令牌/);
  });

  it('**错误令牌 → 401**', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/projects`, {
      headers: { authorization: 'Bearer wrong' },
    });
    assert.equal(res.status, 401);
  });

  it('正确令牌 → 200', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  it('健康检查不需要令牌（桌面壳用它探测就绪）', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
  });

  it('**恶意来源跨源请求 → 403**', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/projects`, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'https://evil.example.com',
      },
    });
    assert.equal(res.status, 403);
  });

  it('**恶意来源的响应不带 Allow-Origin**（浏览器会拦住）', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/projects`, {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('自身来源的响应回显该来源（不是 `*`）', async () => {
    const { base } = await setup();
    const port = new URL(base).port;
    const res = await fetch(`${base}/api/health`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), `http://127.0.0.1:${port}`);
  });

  it('SSE 也需要令牌', async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/api/events`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(res.status, 401);
  });

  it('SSE 带令牌可以连（拿到 200 与事件流）', async () => {
    const { base } = await setup();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /event-stream/);
    controller.abort();
  });
});
