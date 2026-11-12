/**
 * IM 通道测试（Telegram）。
 *
 * **全部脱网**：用假的 fetch 模拟 Telegram API，不假装跑通过真实网络。
 * 这里能证明的是：解析正确、走同一条业务路径、白名单与绑定正确、
 * 审批按钮复用同一套审批记录。
 *
 * 真实网络连通性需要用户自己配 token 后验证，我不会说"测过了"。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parseUpdates, TelegramClient } from '../im/telegram.js';
import { ImBridge } from '../im/bridge.js';
import { ImSettingsStore } from '../im/settings.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient, isExecutorTurn } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-im-'));
  temps.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// 解析（这是最容易出错的地方，也是最值得测的）
// ---------------------------------------------------------------------------

describe('Telegram 更新解析', () => {
  it('解析普通消息', () => {
    const raw = {
      ok: true,
      result: [
        {
          update_id: 100,
          message: {
            chat: { id: 42 },
            text: '改完了吗',
            from: { first_name: '小明' },
            date: 1700000000,
          },
        },
      ],
    };
    const parsed = parseUpdates(raw);
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.messages[0]?.text, '改完了吗');
    assert.equal(parsed.messages[0]?.chatId, '42');
    assert.equal(parsed.messages[0]?.fromName, '小明');
  });

  it('解析按钮点击', () => {
    const raw = {
      ok: true,
      result: [
        {
          update_id: 101,
          callback_query: {
            id: 'cb1',
            data: 'approve:apr_x',
            from: { first_name: '小明' },
            message: { chat: { id: 42 } },
          },
        },
      ],
    };
    const parsed = parseUpdates(raw);
    assert.equal(parsed.callbacks.length, 1);
    assert.equal(parsed.callbacks[0]?.data, 'approve:apr_x');
  });

  it('**offset 必须用 maxUpdateId 推进**（回归：用条数推进会重复处理）', () => {
    const raw = {
      ok: true,
      result: [
        { update_id: 500, message: { chat: { id: 1 }, text: 'a' } },
        { update_id: 507, message: { chat: { id: 1 }, text: 'b' } },
      ],
    };
    const parsed = parseUpdates(raw);
    assert.equal(parsed.maxUpdateId, 507, '要取最大 id，而不是条数 2');
  });

  it('空结果不报错', () => {
    const parsed = parseUpdates({ ok: true, result: [] });
    assert.equal(parsed.messages.length, 0);
    assert.equal(parsed.maxUpdateId, null);
  });

  it('畸形数据不抛异常', () => {
    assert.doesNotThrow(() => parseUpdates(null));
    assert.doesNotThrow(() => parseUpdates({ ok: true, result: 'nope' }));
    assert.doesNotThrow(() => parseUpdates({ ok: true, result: [{}] }));
  });
});

// ---------------------------------------------------------------------------
// 客户端（假 fetch）
// ---------------------------------------------------------------------------

describe('Telegram 客户端', () => {
  it('token 无效时抛出可读错误', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const client = new TelegramClient('bad-token', fakeFetch);
    await assert.rejects(() => client.getMe(), /Unauthorized/);
  });

  it('发消息带按钮', async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;

    const client = new TelegramClient('t', fakeFetch);
    await client.sendMessage('42', 'hi', [[{ text: '批准', data: 'approve:x' }]]);

    assert.ok(captured);
    const markup = (captured as Record<string, unknown>).reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, 'approve:x');
  });
});

// ---------------------------------------------------------------------------
// 配置存储
// ---------------------------------------------------------------------------

describe('IM 配置存储', () => {
  it('保存与读回', async () => {
    const dir = await tmp();
    const store = new ImSettingsStore({ file: path.join(dir, 'im.json') });
    await store.save({ botToken: 'tok', chatIds: ['1'], projectId: 'p1' });
    const read = await store.read();
    assert.equal(read.botToken, 'tok');
    assert.deepEqual(read.chatIds, ['1']);
    assert.equal(read.projectId, 'p1');
  });

  it('文件不存在时返回空配置（不抛）', async () => {
    const dir = await tmp();
    const store = new ImSettingsStore({ file: path.join(dir, 'missing.json') });
    assert.deepEqual(await store.read(), { botToken: '', chatIds: [], projectId: null });
  });

  it('清空后 token 消失', async () => {
    const dir = await tmp();
    const store = new ImSettingsStore({ file: path.join(dir, 'im.json') });
    await store.save({ botToken: 'tok', chatIds: ['1'], projectId: 'p1' });
    await store.clear();
    assert.equal((await store.read()).botToken, '');
  });
});

// ---------------------------------------------------------------------------
// 端到端：走同一条 userSays
// ---------------------------------------------------------------------------

describe('端到端：IM 消息与 Web 走同一条路径', () => {
  it('手机消息进入 Assistant 的同一个会话，回复发回手机', async () => {
    const root = await tmp();
    const store = new MemoryStore();
    const llm = new MockLlmClient((request) =>
      isExecutorTurn(request) ? { text: 'ok' } : { text: '收到，我这就做。' },
    );
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });

    // 把桥接绑到这个真实项目上
    const sent: string[] = [];
    const config = { botToken: 'tok', chatIds: ['42'], projectId: project.id };
    const client = {
      sendMessage: async (_c: string, t: string) => {
        sent.push(t);
      },
      answerCallback: async () => {},
    } as unknown as TelegramClient;
    const bridge = new ImBridge({
      client,
      orchestrator: runtime,
      store,
      config: () => config,
      saveConfig: async () => {},
    });

    await bridge.handleMessage({ chatId: '42', text: '把登录页重构一下', fromName: '小明' });

    // **关键：消息进了 Assistant 的会话历史，和 Web 发的一模一样**
    const history = store.messages(project.assistantSessionId);
    assert.ok(
      history.some((m) => m.role === 'user' && m.content === '把登录页重构一下'),
      'IM 消息必须进同一个 Assistant 会话',
    );
    assert.ok(sent.length > 0, '应当把 Assistant 的回复发回手机');

    await runtime.dispose();
  });

  it('第一个发消息的人自动绑定', async () => {
    const root = await tmp();
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });
    const { project } = await runtime.openProject({ rootPath: root });

    const sent: string[] = [];
    const config = { botToken: 'tok', chatIds: [] as string[], projectId: project.id };
    const bridge = new ImBridge({
      client: {
        sendMessage: async (_c: string, t: string) => {
          sent.push(t);
        },
        answerCallback: async () => {},
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => config,
      saveConfig: async (next) => {
        config.chatIds = [...next.chatIds];
      },
    });

    await bridge.handleMessage({ chatId: '99', text: '你好', fromName: '新用户' });
    assert.deepEqual(config.chatIds, ['99'], '第一个对话应自动绑定');
    assert.match(sent[0] ?? '', /已绑定/);

    await runtime.dispose();
  });

  it('未绑定的第二个对话被拒绝', async () => {
    const root = await tmp();
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });
    const { project } = await runtime.openProject({ rootPath: root });

    const sent: string[] = [];
    const config = { botToken: 'tok', chatIds: ['42'], projectId: project.id };
    const bridge = new ImBridge({
      client: {
        sendMessage: async (_c: string, t: string) => {
          sent.push(t);
        },
        answerCallback: async () => {},
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => config,
      saveConfig: async () => {},
    });

    await bridge.handleMessage({ chatId: '777', text: '我也要用', fromName: '陌生人' });
    assert.match(sent[0] ?? '', /没有绑定/);

    // 陌生人的话不能进 Assistant 的会话
    const history = store.messages(project.assistantSessionId);
    assert.ok(!history.some((m) => m.content === '我也要用'));

    await runtime.dispose();
  });

  it('没绑项目时提示去电脑上设置', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });

    const sent: string[] = [];
    const config = { botToken: 'tok', chatIds: ['42'], projectId: null as string | null };
    const bridge = new ImBridge({
      client: {
        sendMessage: async (_c: string, t: string) => {
          sent.push(t);
        },
        answerCallback: async () => {},
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => config,
      saveConfig: async () => {},
    });

    await bridge.handleMessage({ chatId: '42', text: '做点事', fromName: '小明' });
    assert.match(sent[0] ?? '', /还没有绑定项目/);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// 审批按钮
// ---------------------------------------------------------------------------

describe('手机上的审批按钮复用同一套记录', () => {
  it('点"批准"后网页端看到的也是 approved', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });

    // 造一条待审批
    await store.putApproval({
      id: 'apr_test',
      projectId: 'p1',
      executorId: 'e1',
      category: 'delete',
      evidence: 'rm -rf x',
      why: '测试',
      tool: 'run_command',
      args: '{}',
      status: 'pending',
      decidedReason: null,
      createdAt: Date.now(),
      decidedAt: null,
      expiresAt: Date.now() + 60_000,
    });

    const answered: string[] = [];
    const bridge = new ImBridge({
      client: {
        sendMessage: async () => {},
        answerCallback: async (_id: string, text?: string) => {
          answered.push(text ?? '');
        },
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => ({ botToken: 't', chatIds: ['1'], projectId: 'p1' }),
      saveConfig: async () => {},
    });

    await bridge.handleCallback({ id: 'cb', chatId: '1', data: 'approve:apr_test' });

    // **同一个存储**：网页端查到的也是 approved
    assert.equal(store.getApproval('apr_test')?.status, 'approved');
    assert.match(answered[0] ?? '', /已批准/);

    await runtime.dispose();
  });

  it('点"拒绝"记为 rejected', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({
      store,
      llm: new MockLlmClient(() => ({ text: 'ok' })),
    });
    await store.putApproval({
      id: 'apr_test2',
      projectId: 'p1',
      executorId: 'e1',
      category: 'push',
      evidence: 'git push',
      why: '测试',
      tool: 'run_command',
      args: '{}',
      status: 'pending',
      decidedReason: null,
      createdAt: Date.now(),
      decidedAt: null,
      expiresAt: Date.now() + 60_000,
    });

    const bridge = new ImBridge({
      client: {
        sendMessage: async () => {},
        answerCallback: async () => {},
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => ({ botToken: 't', chatIds: ['1'], projectId: 'p1' }),
      saveConfig: async () => {},
    });

    await bridge.handleCallback({ id: 'cb', chatId: '1', data: 'reject:apr_test2' });
    assert.equal(store.getApproval('apr_test2')?.status, 'rejected');

    await runtime.dispose();
  });

  it('未知的按钮数据被安全忽略', async () => {
    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })) });
    const answers: string[] = [];
    const bridge = new ImBridge({
      client: {
        sendMessage: async () => {},
        answerCallback: async (_id: string, t?: string) => {
          answers.push(t ?? '');
        },
      } as unknown as TelegramClient,
      orchestrator: runtime,
      store,
      config: () => ({ botToken: 't', chatIds: ['1'], projectId: 'p1' }),
      saveConfig: async () => {},
    });

    await bridge.handleCallback({ id: 'cb', chatId: '1', data: 'garbage' });
    assert.match(answers[0] ?? '', /未知操作/);

    await runtime.dispose();
  });
});
