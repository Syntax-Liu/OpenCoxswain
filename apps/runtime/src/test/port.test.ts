/**
 * 端口占用与单实例相关测试。
 *
 * 这里只覆盖**运行时**能证明的部分：端口被占用时给出可读错误。
 *
 * 桌面壳的单实例（第二次双击唤回原窗口）依赖 Tauri 插件，
 * 需要真实开两次窗口才能验证，**这里不假装测过**——
 * 验证方法见 docs/release.md 末尾。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { startServer } from '../server/server.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe('端口被占用', () => {
  it('给出可读提示，而不是裸 EADDRINUSE', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocx-port-'));
    temps.push(root);

    // 先占住一个端口
    const blocker = createServer((_req, res) => res.end('busy'));
    const port = await new Promise<number>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    const runtime = new Orchestrator({ store: new MemoryStore(), llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const { project } = await runtime.openProject({ rootPath: root });
    const store = new MemoryStore();

    try {
      await assert.rejects(
        () =>
          startServer({
            orchestrator: runtime,
            store,
            port,
            host: '127.0.0.1',
          }),
        (error: Error) => {
          // 关键：错误信息要说人话
          assert.match(error.message, /端口 \d+ 已被占用/);
          assert.match(error.message, /已经开了一个/);
          assert.match(error.message, /OPENCOXSWAIN_PORT/);
          assert.doesNotMatch(error.message, /^listen EADDRINUSE/);
          return true;
        },
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      void project;
      await runtime.dispose();
    }
  });
});
