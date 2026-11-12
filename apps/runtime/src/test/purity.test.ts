/**
 * 对话流纯净性测试。
 *
 * 背景（真实问题）：Agent 的结算通知曾经被当成用户消息渲染进对话流，
 * 整块的 `【Agent结算】` + Agent 的原始输出 + "请立刻向用户汇报这一条结果"
 * 都显示给了用户。那既不是用户说的话，也不是 Assistant 的回复。
 *
 * 这里钉死三件事：
 * 1. 内部通知进 Assistant 的上下文（否则 Assistant 不知道结算了）；
 * 2. 内部通知**不进**对话流；
 * 3. 对话流只含用户与 Assistant 的消息。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Orchestrator, INTERNAL_NOTICE_PREFIX } from '../index.js';
import { MemoryStore, isInternalSource, INTERNAL_SOURCE_PREFIX } from '../store/store.js';
import { Inbox } from '../inbox/inbox.js';
import { MockLlmClient, isAssistantTurn, isExecutorTurn, isSettlementNotice } from './mock-llm.js';

describe('Inbox：内部通知标记', () => {
  it('internal 默认为 false（用户消息）', () => {
    const inbox = new Inbox();
    const item = inbox.push('你好');
    assert.equal(item.internal, false);
  });

  it('internal=true 会被保留', () => {
    const inbox = new Inbox();
    const item = inbox.push('【Agent结算】...', { internal: true, source: 'executor' });
    assert.equal(item.internal, true);
    assert.equal(item.source, 'executor');
  });

  it('**图片附件会被带上**（漏传会让图在入库前就丢了）', () => {
    const inbox = new Inbox();
    const images = [{ type: 'image' as const, dataUrl: 'data:image/png;base64,AAA', name: 'a.png' }];
    const item = inbox.push('看这张图', { images });
    assert.equal(item.images?.length, 1);
    const first = item.images?.[0];
    assert.equal(first?.type, 'image');
    // 收窄后才有 name 字段
    if (first?.type === 'image') assert.equal(first.name, 'a.png');
  });

  it('没有图片时不产生 images 字段', () => {
    const inbox = new Inbox();
    assert.equal(inbox.push('纯文本').images, undefined);
  });
});

describe('内部消息来源标记', () => {
  it('internal: 前缀可识别', () => {
    assert.equal(isInternalSource(`${INTERNAL_SOURCE_PREFIX}executor`), true);
    assert.equal(isInternalSource('webapp'), false);
    assert.equal(isInternalSource('executor'), false);
  });
});

describe('Agent结算不进对话流', () => {
  it('结算通知进入 Assistant 的上下文，但历史里标为 internal', async () => {
    const store = new MemoryStore();
    const llm = new MockLlmClient((request) => {
      if (isExecutorTurn(request)) {
        return {
          text: [
            '结论：已创建文件。',
            '### 做了什么',
            '新建 a.txt',
            '### 验证了什么',
            '未验证',
            '### 需要用户决定什么',
            '无',
          ].join('\n'),
        };
      }
      if (isSettlementNotice(request)) return { text: '已完成，向你汇报。' };
      if (isAssistantTurn(request)) {
        // 第一次：派活；之后：普通回复
        const toolMsgs = request.messages.filter((m) => m.role === 'tool');
        if (toolMsgs.length === 0 && request.messages.some((m) => m.role === 'tool') === false) {
          const userText = request.messages.find((m) => m.role === 'user')?.content;
          if (typeof userText === 'string' && userText.includes('创建')) {
            return {
              tool: 'spawn_executor',
              args: { label: '写文件', goal: '创建 a.txt', writeScope: [] },
              text: '收到，我派Agent去创建。',
            };
          }
        }
        return { text: '好的。' };
      }
      return { text: 'ok' };
    });

    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: 'D:/work/purity' });

    await runtime.userSays(project.id, '帮我创建 a.txt');
    await waitFor(
      () => store.listReports({ projectId: project.id }).length > 0,
      8000,
    );
    await waitFor(() => !runtime.getAssistant(project.id)?.isRunning, 5000);

    const history = store.messages(project.assistantSessionId);
    const internal = history.filter((m) => isInternalSource(m.source));
    const normalUser = history.filter((m) => m.role === 'user' && !isInternalSource(m.source));

    // 结算通知确实进了历史（C 需要它）
    assert.ok(internal.length >= 1, '内部通知应进入 Assistant 的上下文');
    assert.match(internal[0]!.content, new RegExp(INTERNAL_NOTICE_PREFIX));

    // 但用户消息只有自己说的那句
    assert.equal(normalUser.length, 1, '用户消息只应有真正发的那一条');
    assert.equal(normalUser[0]!.content, '帮我创建 a.txt');

    // 没有一条"用户消息"里含内部提示词
    for (const m of normalUser) {
      assert.doesNotMatch(m.content, /请立刻向用户汇报/, '内部指令不能出现在用户消息里');
    }

    await runtime.dispose();
  });

  it('chatHistory 把内部通知标明为系统通知，不冒充用户发言', async () => {
    const store = new MemoryStore();
    await store.putSession({
      id: 'c1',
      kind: 'assistant',
      projectId: 'prj_1',
      parentSessionId: null,
      label: 'C',
      systemPrompt: 'SYS',
      status: 'idle',
      resumable: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.appendMessage('c1', {
      id: 'm1',
      role: 'user',
      content: '你好',
      source: 'webapp',
      at: 2,
    });
    await store.appendMessage('c1', {
      id: 'm2',
      role: 'user',
      content: '【Agent结算】\n已完成',
      source: `${INTERNAL_SOURCE_PREFIX}executor`,
      at: 3,
    });

    const history = store.chatHistory('c1');
    const userTurns = history.filter((m) => m.role === 'user');
    assert.equal(userTurns.length, 2);
    assert.equal(userTurns[0]!.content, '你好');
    assert.match(String(userTurns[1]!.content), /系统通知，不是用户说的话/);
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
