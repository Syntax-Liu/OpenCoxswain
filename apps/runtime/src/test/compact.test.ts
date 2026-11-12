/**
 * 上下文压缩测试。
 *
 * 这是 P0 缺口：不压缩，跑几十步就会超模型上下文窗口然后整轮失败。
 *
 * 这组测试守三件事：
 * 1. 工具结果剪枝有效且保留首尾
 * 2. 折叠中间历史时**不破坏「调用↔结果」配对**（破坏会让服务端直接 400）
 * 3. 不超限时什么都不动（不做无谓的信息损失）
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatMessage } from '../llm/types.js';
import {
  DEFAULT_TOKEN_LIMIT,
  compactMessages,
  estimateMessages,
  estimateTokens,
  findSafeCut,
  isSafeCut,
  pruneText,
} from '../session/compact.js';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ role, content, ...extra }) as ChatMessage;

describe('token 估算', () => {
  it('中文按字算', () => {
    assert.equal(estimateTokens('你好世界'), 4);
  });

  it('英文按 4 字符约 1 token', () => {
    assert.equal(estimateTokens('abcdefgh'), 2);
  });

  it('空串为 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('混排时都算上', () => {
    const n = estimateTokens('中文abcd');
    assert.ok(n > 2 && n < 10, `估算值异常：${n}`);
  });

  it('消息列表累加，含工具调用的参数', () => {
    const messages = [
      msg('user', 'abcdefgh'),
      msg('assistant', '', { tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: 'abcdefgh' } }] }),
    ];
    assert.ok(estimateMessages(messages) > 4);
  });
});

describe('工具结果剪枝', () => {
  it('不超预算时原样返回', () => {
    const r = pruneText('short', 100);
    assert.equal(r.pruned, false);
    assert.equal(r.text, 'short');
  });

  it('**超预算时保留头尾，中间省略**', () => {
    const long = 'A'.repeat(200) + 'MIDDLE' + 'B'.repeat(200);
    const r = pruneText(long, 100);
    assert.equal(r.pruned, true);
    assert.ok(r.text.startsWith('A'), '应保留开头');
    assert.ok(r.text.endsWith('B'), '应保留结尾');
    assert.match(r.text, /中间省略/);
    assert.ok(r.text.length < long.length);
  });

  it('省略数量写得清楚', () => {
    const r = pruneText('x'.repeat(1000), 100);
    assert.match(r.text, /省略 \d+ 字/);
  });
});

describe('配对安全的切点', () => {
  // index 表示「丢弃 [0, index)」，所以 messages[index] 是新历史的第一条。
  // 它不能是 tool —— 那意味着工具的调用方被切掉了。
  const messages: ChatMessage[] = [
    msg('user', '目标'), // 0
    msg('assistant', '', {
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
    }), // 1
    msg('tool', '结果1', { tool_call_id: 'c1' }), // 2
    msg('assistant', '看完了'), // 3
    msg('user', '继续'), // 4
  ];

  it('**切点落在 tool 上不安全**（会留下孤立的结果）', () => {
    assert.equal(isSafeCut(messages, 2), false, 'index 2 是 tool');
  });

  it('切点落在普通消息上安全', () => {
    assert.equal(isSafeCut(messages, 0), true);
    assert.equal(isSafeCut(messages, 1), true);
    assert.equal(isSafeCut(messages, 3), true);
    assert.equal(isSafeCut(messages, 4), true);
  });

  it('切到末尾（全部丢弃）算安全', () => {
    assert.equal(isSafeCut(messages, messages.length), true);
  });

  it('findSafeCut 会从 tool 位置往回退', () => {
    assert.equal(findSafeCut(messages, 2), 1, 'index 2 是 tool，退到 1');
  });

  it('本来就是安全位置时不退', () => {
    assert.equal(findSafeCut(messages, 3), 3);
  });
});

describe('整体压缩', () => {
  it('**不超限时什么都不改**', () => {
    const messages = [msg('user', '你好'), msg('assistant', '你好')];
    const r = compactMessages(messages);
    assert.equal(r.changed, false);
    assert.equal(r.messages.length, 2);
  });

  it('超长工具结果会被剪枝', () => {
    const messages = [
      msg('user', '读文件'),
      msg('tool', 'x'.repeat(20_000), { tool_call_id: 'c1' }),
    ];
    const r = compactMessages(messages, { toolResultBudget: 500 });
    assert.equal(r.prunedToolResults, 1);
    assert.equal(r.changed, true);
    assert.ok(r.tokensAfter < r.tokensBefore);
  });

  it('仍然超限时折叠中间历史', () => {
    const messages: ChatMessage[] = [msg('user', '最初的目标')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(msg('user', `第 ${i} 轮`));
      messages.push(msg('assistant', '好的'.repeat(200)));
    }

    const r = compactMessages(messages, { tokenLimit: 500, keepRecent: 6, toolResultBudget: 10_000 });
    assert.ok(r.droppedMessages > 0, '应当折叠了一些历史');
    assert.ok(r.messages.length < messages.length);
    assert.equal(r.messages[0]?.content, '最初的目标', '第一条（目标）必须保留');
    assert.ok(
      r.messages.some((m) => String(m.content ?? '').includes('已折叠')),
      '应当留下折叠说明',
    );
  });

  it('**折叠后不出现孤立 tool 消息**', () => {
    const messages: ChatMessage[] = [msg('user', '目标')];
    for (let i = 0; i < 30; i += 1) {
      messages.push(
        msg('assistant', '', {
          tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }],
        }),
      );
      messages.push(msg('tool', 'y'.repeat(500), { tool_call_id: `c${i}` }));
    }

    const r = compactMessages(messages, { tokenLimit: 300, keepRecent: 8, toolResultBudget: 100_000 });

    // 压缩后，第一条 tool 消息之前必须有对应的 assistant 调用
    const firstTool = r.messages.findIndex((m) => m.role === 'tool');
    if (firstTool > 0) {
      // 往前找最近的 assistant，它必须带 tool_calls
      let found = false;
      for (let i = firstTool - 1; i >= 0; i -= 1) {
        if (r.messages[i]!.role === 'assistant') {
          found = (r.messages[i]!.tool_calls?.length ?? 0) > 0;
          break;
        }
        if (r.messages[i]!.role === 'user') break;
      }
      assert.ok(found, '孤立的 tool 消息会让服务端直接 400');
    }
  });

  it('空列表不出错', () => {
    const r = compactMessages([]);
    assert.equal(r.changed, false);
    assert.equal(r.messages.length, 0);
  });

  it('默认上限是合理的值', () => {
    assert.ok(DEFAULT_TOKEN_LIMIT > 50_000, '上限太低会过早压缩');
  });
});
