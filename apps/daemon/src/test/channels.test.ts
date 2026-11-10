import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  Approval,
  ChannelView,
  EventRecord,
  Project,
  Task,
} from '@opencoxswain/shared';
import type {
  ChannelTransport,
  EventService,
  StewardService,
  StorageService,
} from '@opencoxswain/plugin-api';
import { Channels, parseChannelCommand } from '../channels.js';
import {
  decryptFeishu,
  feishuInboundSignature,
  feishuSign,
  sendFeishuMessage,
} from '../plugins/channel-feishu.js';
import {
  extractTelegramText,
  sendTelegramMessage,
  telegramChatId,
  telegramUpdateId,
} from '../plugins/channel-telegram.js';
import { delay, makeDaemon, makeRepo } from './helpers.js';

function project(): Project {
  return {
    id: 'prj_demo',
    name: '演示项目',
    path: 'D:/demo',
    defaultBranch: 'main',
    dailyBudgetUsd: 5,
    maxConcurrency: 1,
    allowNetwork: false,
    allowExternalSend: false,
    createdAt: 0,
  };
}

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'prj_demo',
    parentId: null,
    title: '演示任务',
    goal: '目标',
    status: 'awaiting_approval',
    assigneeId: null,
    contract: {} as Task['contract'],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function approval(partial: Partial<Approval> & { id: string; taskId: string }): Approval {
  return {
    type: 'tool',
    requestedBy: 'worker',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    payload: { tool: 'write' },
    createdAt: 0,
    ...partial,
  };
}

interface Harness {
  channels: Channels;
  sent: string[];
  calls: string[];
}

async function harness(
  options: {
    tasks?: Task[];
    approvals?: Approval[];
    transport?: ChannelTransport;
    home?: string;
  } = {},
): Promise<Harness> {
  const home = options.home ?? (await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-ch-')));
  const tasks = options.tasks ?? [];
  const approvals = options.approvals ?? [];
  const calls: string[] = [];
  const store = {
    listProjects: () => [project()],
    getProject: (id: string) => (id === project().id ? project() : null),
    listTasks: (projectId: string) => tasks.filter((item) => item.projectId === projectId),
    getTask: (id: string) => tasks.find((item) => item.id === id) ?? null,
    listApprovals: () => approvals,
  } as unknown as StorageService;
  const steward = {
    approveTask: (id: string) => {
      calls.push(`approve:${id}`);
      const found = tasks.find((item) => item.id === id);
      if (!found) throw new Error('任务不存在');
      return found;
    },
    rejectTask: (id: string, note?: string) => {
      calls.push(`reject:${id}:${note ?? ''}`);
      const found = tasks.find((item) => item.id === id);
      if (!found) throw new Error('任务不存在');
      return found;
    },
    decideApproval: (id: string, decision: string) => {
      calls.push(`decide:${id}:${decision}`);
      return approvals.find((item) => item.id === id) ?? ({} as Approval);
    },
  } as unknown as StewardService;
  const bus = {
    subscribe: () => () => undefined,
  } as unknown as EventService;
  const sent: string[] = [];
  const channels = new Channels({
    store,
    bus,
    steward,
    filePath: path.join(home, 'channels.json'),
  });
  const transport = options.transport ?? {
    send: async (message) => {
      sent.push(message.text);
    },
  };
  channels.registerTransport('feishu', transport);
  return { channels, sent, calls };
}

function event(partial: Partial<EventRecord> & { type: string }): EventRecord {
  return {
    id: 1,
    taskId: 'tsk_demo001',
    workerId: null,
    payload: {},
    createdAt: 0,
    ...partial,
  };
}

test('入站指令：只识别只读查询与拍板动作，退回必须带理由', () => {
  assert.deepEqual(parseChannelCommand('待办'), { kind: 'list' });
  assert.deepEqual(parseChannelCommand('  @_user_1  批准   tsk_abcd  '), {
    kind: 'approve',
    id: 'tsk_abcd',
  });
  assert.deepEqual(parseChannelCommand('退回 apr_1234 范围太大'), {
    kind: 'reject',
    id: 'apr_1234',
    note: '范围太大',
  });
  assert.deepEqual(parseChannelCommand('退回 apr_1234'), {
    kind: 'unknown',
    text: '退回 apr_1234',
  });
  assert.deepEqual(parseChannelCommand('状态 tsk_abcd'), { kind: 'status', id: 'tsk_abcd' });
  assert.deepEqual(parseChannelCommand('帮我修个 bug'), {
    kind: 'unknown',
    text: '帮我修个 bug',
  });
  assert.deepEqual(parseChannelCommand('？'), { kind: 'help' });
});

test('通道：事件推送去重、通知范围与测试发送', async () => {
  const fixture = await harness({ tasks: [task({ id: 'tsk_demo001', title: '接入登录' })] });
  const created = fixture.channels.save({
    kind: 'feishu',
    name: '研发群',
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo',
    notify: ['approval', 'budget'],
  });
  assert.equal(created.webhookConfigured, true);
  assert.equal(created.secretConfigured, false);
  assert.deepEqual(created.notify, ['approval', 'budget']);

  const approvalEvent = event({
    type: 'approval.requested',
    payload: { approvalId: 'apr_demo1234', type: 'tool', tool: 'write', category: 'fs' },
  });
  fixture.channels.dispatch(approvalEvent);
  fixture.channels.dispatch(approvalEvent);
  await delay(0);
  assert.equal(fixture.sent.length, 1, '同一审批在静默窗口内只推一次');
  assert.match(fixture.sent[0] ?? '', /接入登录/);
  assert.match(fixture.sent[0] ?? '', /批准 apr_demo1234/);

  fixture.channels.dispatch(
    event({
      type: 'task.status_changed',
      payload: { from: 'running', to: 'awaiting_review' },
    }),
  );
  await delay(0);
  assert.equal(fixture.sent.length, 1, '未订阅的通知类别不推送');

  fixture.channels.dispatch(
    event({
      type: 'budget.exceeded',
      payload: { scope: 'daily', projectId: 'prj_demo', used: 5.2, limit: 5 },
    }),
  );
  await delay(0);
  assert.equal(fixture.sent.length, 2);
  assert.match(fixture.sent[1] ?? '', /项目日预算/);

  const result = await fixture.channels.test(created.id);
  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(fixture.sent.length, 3);
  assert.equal(fixture.channels.list()[0]?.lastError, null);
});

test('通道：发送失败记录到通道状态但不抛出', async () => {
  const fixture = await harness({
    transport: {
      send: async () => {
        throw new Error('gateway down');
      },
    },
  });
  const created = fixture.channels.save({
    kind: 'feishu',
    webhookUrl: 'https://example.com/hook',
  });
  const result = await fixture.channels.test(created.id);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'gateway down');
  assert.equal(fixture.channels.get(created.id)?.lastError, 'gateway down');
});

test('入站指令：批准任务、拒绝审批，未知 id 给出明确提示', async () => {
  const tasks = [
    task({ id: 'tsk_demo001', title: '接入登录' }),
    task({ id: 'tsk_review1', title: '待验收任务', status: 'awaiting_review' }),
  ];
  const approvals = [approval({ id: 'apr_demo1234', taskId: 'tsk_demo001' })];
  const fixture = await harness({ tasks, approvals });
  const created = fixture.channels.save({ kind: 'feishu', name: '飞书' });

  const approved = await fixture.channels.inbound(created.id, '批准 tsk_demo001');
  assert.equal(approved.handled, true);
  assert.match(approved.reply, /已批准任务/);
  assert.deepEqual(fixture.calls, ['approve:tsk_demo001']);

  const rejected = await fixture.channels.inbound(created.id, '退回 apr_demo1234 权限过大');
  assert.equal(rejected.handled, true);
  assert.match(rejected.reply, /已拒绝审批/);
  assert.deepEqual(fixture.calls[1], 'decide:apr_demo1234:rejected');

  const missing = await fixture.channels.inbound(created.id, '批准 tsk_nope');
  assert.match(missing.reply, /没有找到匹配的任务或审批/);

  const ambiguous = await fixture.channels.inbound(created.id, '批准 tsk_');
  assert.match(ambiguous.reply, /匹配到多条/);
});

test('飞书：出站签名与返回码校验', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  }) as unknown as typeof fetch;

  await sendFeishuMessage({
    webhookUrl: 'https://example.com/hook',
    secret: 'sec',
    text: 'hello',
    timestamp: 1_700_000_000,
    fetchImpl,
  });
  assert.deepEqual(bodies[0]?.content, { text: 'hello' });
  assert.equal(bodies[0]?.timestamp, '1700000000');
  assert.equal(bodies[0]?.sign, feishuSign('sec', 1_700_000_000));

  const failing = (async () =>
    new Response(JSON.stringify({ code: 19024, msg: 'signature invalid' }), {
      status: 200,
    })) as unknown as typeof fetch;
  await assert.rejects(
    sendFeishuMessage({
      webhookUrl: 'https://example.com/hook',
      secret: '',
      text: 'hello',
      fetchImpl: failing,
    }),
    /signature invalid/,
  );
});

test('飞书：入站签名、解密与 challenge 校验', async () => {
  const fixture = await makeRepo({ 'README.md': 'origin\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const channel = await daemon.call<ChannelView>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ kind: 'feishu', name: '飞书' }),
    });
    assert.equal(channel.webhookConfigured, false);
    assert.match(channel.inboundPath, /\/inbound$/);
    assert.ok(channel.inboundToken.startsWith('itk_'));

    const base = `http://127.0.0.1:${daemon.app.port}${channel.inboundPath}`;
    const timestamp = '1700000000';
    const nonce = 'nonce-1';
    const body = JSON.stringify({ challenge: 'challenge-abc', type: 'url_verification' });
    const signature = feishuInboundSignature(channel.inboundToken, timestamp, nonce, body);
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': signature,
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { challenge: 'challenge-abc' });

    const bad = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': 'deadbeef',
      },
      body,
    });
    assert.equal(bad.status, 401);

    const noAuth = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(noAuth.status, 401);

    const text = JSON.stringify({
      event: {
        message: { message_type: 'text', content: JSON.stringify({ text: '待办' }) },
      },
    });
    const textSignature = feishuInboundSignature(channel.inboundToken, timestamp, nonce, text);
    const handled = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': textSignature,
      },
      body: text,
    });
    assert.equal(handled.status, 200);
    assert.deepEqual(await handled.json(), { code: 0, msg: 'ok' });

    // 加密回调：Encrypt Key 即入站 token，AES-256-CBC 的 IV 取密文前 16 字节。
    const encrypted = encryptForTest(channel.inboundToken, JSON.stringify({ challenge: 'enc' }));
    const encryptedBody = JSON.stringify({ encrypt: encrypted });
    const encryptedSignature = feishuInboundSignature(
      channel.inboundToken,
      timestamp,
      nonce,
      encryptedBody,
    );
    const decryptedResponse = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': timestamp,
        'x-lark-request-nonce': nonce,
        'x-lark-signature': encryptedSignature,
      },
      body: encryptedBody,
    });
    assert.equal(decryptedResponse.status, 200);
    assert.deepEqual(await decryptedResponse.json(), { challenge: 'enc' });
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** 与 decryptFeishu 对称：sha256(key) 作密钥，随机 IV 放在密文头部。 */
function encryptForTest(key: string, plain: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, data]).toString('base64');
}

// 单独验证解密函数，避免上层出错时难以定位。
test('飞书：解密函数可还原明文', () => {
  const payload = encryptForTest('enc-key', '{"hello":"world"}');
  assert.equal(decryptFeishu('enc-key', payload), '{"hello":"world"}');
});

test('Telegram：出站地址、请求体与失败返回校验', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;

  await sendTelegramMessage({
    botToken: '123456:ABC',
    chatId: '-100123',
    text: 'hello',
    fetchImpl,
  });
  assert.equal(calls[0]?.url, 'https://api.telegram.org/bot123456:ABC/sendMessage');
  assert.equal(calls[0]?.body.chat_id, '-100123');
  assert.equal(calls[0]?.body.text, 'hello');

  const failing = (async () =>
    new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
      status: 200,
    })) as unknown as typeof fetch;
  await assert.rejects(
    sendTelegramMessage({ botToken: 't', chatId: '1', text: 'x', fetchImpl: failing }),
    /chat not found/,
  );

  const httpError = (async () =>
    new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    sendTelegramMessage({ botToken: 't', chatId: '1', text: 'x', fetchImpl: httpError }),
    /HTTP 401/,
  );
});

test('Telegram：update 解析只认文本与数字 update_id', () => {
  const update = {
    update_id: 42,
    message: { chat: { id: -100123 }, text: '待办' },
    edited_message: { chat: { id: 9 }, text: '忽略' },
  };
  assert.equal(telegramUpdateId(update), 42);
  assert.equal(telegramChatId(update), '-100123');
  assert.equal(extractTelegramText(update), '待办');
  assert.equal(telegramUpdateId({ message: {} }), null);
  assert.equal(telegramChatId({ message: {} }), null);
  assert.equal(extractTelegramText({ message: { sticker: {} } }), null);
});

test('Telegram：入站校验 secret_token、只处理绑定会话并去重', async () => {
  const repo = await makeRepo({ 'README.md': 'origin\n' });
  const daemon = await makeDaemon(repo.home);
  const originalFetch = globalThis.fetch;
  const pushed: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.telegram.org/')) {
      pushed.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    return originalFetch(url, init);
  }) as typeof fetch;
  try {
    const channel = await daemon.call<ChannelView>('/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'telegram',
        name: 'Telegram',
        botToken: '123456:ABC',
        chatId: '-100123',
      }),
    });
    assert.equal(channel.kind, 'telegram');
    assert.equal(channel.botTokenConfigured, true);
    assert.equal(channel.chatId, '-100123');
    assert.match(channel.inboundPath, /\/inbound\/telegram$/);

    const base = `http://127.0.0.1:${daemon.app.port}${channel.inboundPath}`;
    const send = (body: unknown, secret?: string) =>
      fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }),
        },
        body: JSON.stringify(body),
      });

    const unauthorized = await send({ update_id: 1, message: { chat: { id: -100123 }, text: '待办' } });
    assert.equal(unauthorized.status, 401);

    const wrongChat = await send(
      { update_id: 2, message: { chat: { id: 777 }, text: '待办' } },
      channel.inboundToken,
    );
    assert.equal(wrongChat.status, 200);
    assert.equal(pushed.length, 0, '非绑定会话不回复');

    const delivered = await send(
      { update_id: 3, message: { chat: { id: -100123 }, text: '待办' } },
      channel.inboundToken,
    );
    assert.equal(delivered.status, 200);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0]?.body.chat_id, '-100123');
    assert.match(String(pushed[0]?.body.text), /待审批|待验收/);

    // 同一个 update_id 重投不再执行。
    const duplicated = await send(
      { update_id: 3, message: { chat: { id: -100123 }, text: '待办' } },
      channel.inboundToken,
    );
    assert.equal(duplicated.status, 200);
    assert.equal(pushed.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await daemon.app.close();
    await rm(repo.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
