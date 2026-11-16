import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { LlmProvider } from '../llm/settings.js';

/**
 * 代理类必须转发 `chatStream`。
 *
 * ## 2026-11-16 踩到的坑
 *
 * 流式上线后用户反馈：
 *
 * > 似乎仍然是整段蹦出来的
 *
 * 查日志：
 *
 *     [诊断] llm=deferred 有chatStream=false
 *
 * `loop` 用 `typeof llm.chatStream === 'function'` 决定走不走流式。
 * 而 `this.llm` 是 **LlmProvider**（name = 'deferred'），不是
 * `OpenAiCompatClient`。provider 只实现了 `chat`，所以——
 *
 *   **真 client 明明有流式能力，却永远用不上，而且不报错。**
 *
 * 教训：代理类必须把接口里的可选项也转发，否则被代理者的能力
 * 会被静默吞掉。这类 bug 最难查，因为它没有任何报错。
 */
describe('**LlmProvider 必须转发 chatStream**', () => {
  it('provider 上有 chatStream 方法', () => {
    assert.equal(
      typeof LlmProvider.prototype.chatStream,
      'function',
      'LlmProvider 没有 chatStream —— 流式会被静默退回非流式',
    );
  });

  it('源码里确实转发了（不是空实现）', () => {
    const src = readFileSync(new URL('../../src/llm/settings.ts', import.meta.url), 'utf8');
    const start = src.indexOf('chatStream(');
    assert.ok(start > 0, '找不到 chatStream 定义');
    const block = src.slice(start, start + 600);
    assert.match(
      block,
      /this\.client\.chatStream\(/,
      '没有转发给真正的 client —— 等于空实现',
    );
  });

  it('没有密钥时给可读错误（和 chat 一致）', async () => {
    const provider = new LlmProvider({
      resolve: async () => null,
    } as never);

    await assert.rejects(
      () => provider.chatStream({ messages: [], tools: [], signal: AbortSignal.timeout(1) } as never, () => {}),
      /尚未配置模型密钥/,
      '没密钥时应该给可读错误，不是空指针',
    );
  });
});

/**
 * 循环层要优先用流式。
 */
describe('**loop 优先走流式**', () => {
  const src = readFileSync(new URL('../../src/session/loop.ts', import.meta.url), 'utf8');

  it('检查 chatStream 是否存在', () => {
    assert.match(src, /typeof llm\.chatStream === 'function'/, '没检查 chatStream');
  });

  it('**有就调用它**', () => {
    assert.match(src, /llm\.chatStream!?\(/, '没调用 chatStream');
  });

  it('没有就退回 chat（兼容老 client）', () => {
    assert.match(src, /llm\.chat\(/, '没有退回路径');
  });

  it('把 onDelta 传下去', () => {
    const start = src.indexOf('llm.chatStream!');
    const block = src.slice(start, start + 400);
    assert.match(block, /onDelta\?\.\(delta\)/, '没用 onDelta 上报增量');
  });
});
