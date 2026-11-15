import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { toWireMessages } from '../llm/types.js';
import type { ChatMessage } from '../llm/types.js';

/**
 * 思考模式的 `reasoning_content` 必须回传。
 *
 * ## 为什么这是"Assistant 不肯派活"的真正根因
 *
 * DeepSeek 文档（思考模式 → 工具调用）原话：
 *
 * > 携带了 `tools` 参数的请求，在后续所有请求中，**必须完整回传
 * > `reasoning_content`** —— 即使该轮模型未实际进行工具调用。
 * > 若您的代码中未正确回传，API 会返回 400 报错。
 *
 * 而 `deepseek-flash` 的**思考模式默认打开**、effort 默认 high。
 *
 * 我们原来的代码：
 *   - 解析响应时没读 `reasoning_content`
 *   - tool loop 里没存进 assistant 消息
 *   - 发请求时也没回传
 *
 * 后果不是显式报错，而是**工具循环整轮崩掉**。模型于是学会了
 * "只写文字、不调工具"——用户看到的是"要说很多次'需要'才派活"。
 *
 * ## 这条测试锁什么
 *
 * 三处缺一不可：解析 → 存储 → 回传。任一处断了就白修。
 */
describe('**reasoning_content 必须回传**', () => {
  it('toWireMessages 会带上 reasoning_content', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'spawn_executor', arguments: '{}' } },
        ],
        reasoning_content: '用户要我派个 Agent 去查，我应该调用 spawn_executor。',
      },
    ];
    const wire = toWireMessages(messages, { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.equal(wire.length, 1);
    assert.equal(
      wire[0]?.reasoning_content,
      '用户要我派个 Agent 去查，我应该调用 spawn_executor。',
      '回传时丢了 reasoning_content —— 带 tools 的下一轮会被 API 400',
    );
  });

  it('没有 reasoning_content 时不写这个字段（不污染请求）', () => {
    const messages: ChatMessage[] = [{ role: 'assistant', content: '好的' }];
    const wire = toWireMessages(messages, { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.equal('reasoning_content' in (wire[0] ?? {}), false);
  });

  it('tool 消息和 user 消息不受影响', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '派个 Agent' },
      { role: 'tool', content: 'exe_abc123', tool_call_id: 'call_1' },
    ];
    const wire = toWireMessages(messages, { supportsImages: false }) as Array<Record<string, unknown>>;
    assert.equal(wire[0]?.role, 'user');
    assert.equal(wire[1]?.tool_call_id, 'call_1');
    assert.equal('reasoning_content' in (wire[0] ?? {}), false);
  });
});

describe('**解析响应时要读出 reasoning_content**', () => {
  it('types.ts 的响应类型包含 reasoning_content', () => {
    const src = readFileSync(new URL('../../src/llm/types.ts', import.meta.url), 'utf8');
    assert.match(src, /reasoning_content\?: string \| null/, '响应类型里没有 reasoning_content');
    assert.match(src, /reasoningContent:\s*message\.reasoning_content/, '没把它读进返回值');
  });
});

describe('**tool loop 要把它存进 assistant 消息**', () => {
  it('loop.ts 里 assistant 消息带 reasoning_content', () => {
    const src = readFileSync(new URL('../../src/session/loop.ts', import.meta.url), 'utf8');
    assert.match(
      src,
      /reasoning_content:\s*response\.reasoningContent/,
      'loop 没把思维链存进 assistant 消息 —— 下一轮回传时就是 undefined',
    );
  });
});
