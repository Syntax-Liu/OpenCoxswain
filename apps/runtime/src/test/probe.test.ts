/**
 * SSE 首帧延迟的回归守卫。
 *
 * 背景：开发中曾出现"连上 SSE 但 15 秒才拿到响应头"的问题。根因是服务端
 * `writeHead()` 之后没有 flush，客户端 fetch 只能等到第一个真实数据块
 * 或超时才拿到响应头。
 *
 * 修复：`server.ts` 里 `res.flushHeaders()` + 立刻写一条 `: connected` 注释。
 *
 * 这个文件保留一个最小断言，确保修复不会在重构中被回退。
 * 更完整的 HTTP 行为覆盖见 `server.test.ts`。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { startServer } from '../server/server.js';
import { MockLlmClient } from './mock-llm.js';

describe('SSE 首帧延迟（回归）', () => {
  it('连接后 3 秒内必须拿到响应头', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });
    const server = await startServer({ orchestrator: runtime, store, port: 0 });

    try {
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
      assert.ok(elapsed < 3000, `首帧用了 ${elapsed}ms，必须立即 flushHeaders`);
    } finally {
      await server.close();
      await runtime.dispose();
    }
  });
});
