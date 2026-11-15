/**
 * 界面状态合并测试。
 *
 * 这些是纯函数，不需要 DOM。合并逻辑写错的后果很具体：
 * - 消息重复 → 用户以为 C 说了两遍；
 * - 增量丢失 → 界面显示一个已经结束的Agent"还在跑"。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyEvent,
  applySnapshot,
  appendUserMessage,
  initialState,
  mergeAssistantText,
  upsertExecutor,
  visibleExecutors,
} from '../state.js';
import type { ExecutorDto, MessageDto } from '../api.js';

const userMessage: MessageDto = {
  id: 'm1',
  role: 'user',
  content: '你好',
  source: 'webapp',
  at: 1,
};

function executor(over: Partial<ExecutorDto> = {}): ExecutorDto {
  return {
    id: 'exe_1',
    projectId: 'prj_1',
    sessionId: 'd_1',
    label: 'Agent',
    goal: 'g',
    writeScope: [],
    status: 'running',
    summary: null,
    blockedReason: null,
    createdAt: 1,
    endedAt: null,
    ...over,
  };
}

describe('快照与增量合并', () => {
  it('快照整体替换对应字段', () => {
    const next = applySnapshot(initialState, {
      projects: [],
      messages: [userMessage],
      lastSeq: 5,
    });
    assert.equal(next.messages.length, 1);
    assert.equal(next.appliedSeq, 5);
  });

  it('重复 seq 的事件被忽略（重连补发不重复显示）', () => {
    const base = { ...initialState, currentProjectId: 'prj_1', appliedSeq: 10 };
    const next = applyEvent(base, 10, {
      type: 'assistant_text',
      projectId: 'prj_1',
      text: '重复',
    });
    assert.equal(next.messages.length, 0, 'seq 已应用过，不应再加一条');
  });

  it('新 seq 的助手文本会出现在消息里', () => {
    const base = { ...initialState, currentProjectId: 'prj_1', appliedSeq: 1 };
    const next = applyEvent(base, 2, {
      type: 'assistant_text',
      projectId: 'prj_1',
      text: '收到',
    });
    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0]?.content, '收到');
    assert.equal(next.thinking, false);
  });

  it('别的项目的事件不影响当前项目', () => {
    const base = { ...initialState, currentProjectId: 'prj_1' };
    const next = applyEvent(base, 3, {
      type: 'assistant_text',
      projectId: 'prj_2',
      text: '别的项目',
    });
    assert.equal(next.messages.length, 0);
  });

  it('Agent事件按 id upsert，不重复', () => {
    const base = { ...initialState, currentProjectId: 'prj_1' };
    const first = applyEvent(base, 1, {
      type: 'executor_started',
      projectId: 'prj_1',
      executor: executor(),
    });
    const second = applyEvent(first, 2, {
      type: 'executor_settled',
      projectId: 'prj_1',
      executor: executor({ status: 'done', summary: '完成' }),
      ok: true,
    });
    assert.equal(second.executors.length, 1);
    assert.equal(second.executors[0]?.status, 'done');
  });

  it('同一条汇报不会重复加入', () => {
    const report = {
      id: 'r1',
      projectId: 'prj_1',
      executorId: 'exe_1',
      kind: 'done' as const,
      body: '完成',
      needsUser: false,
      at: 1,
      ackedAt: null,
    };
    const base = { ...initialState, currentProjectId: 'prj_1' };
    const once = applyEvent(base, 1, { type: 'report', projectId: 'prj_1', report });
    const twice = applyEvent(once, 2, { type: 'report', projectId: 'prj_1', report });
    assert.equal(twice.reports.length, 1);
  });
});

describe('助手文本合并', () => {
  it('同一轮的多段回复拼成一条', () => {
    const first = mergeAssistantText([], '收到，我派 X 去做。');
    const merged = mergeAssistantText(first, '已完成。');
    assert.equal(merged.length, 1);
    assert.match(merged[0]!.content, /收到，我派 X 去做。\n\n已完成。/);
  });

  it('用户消息之后的回复是新的一条', () => {
    const messages: MessageDto[] = [userMessage];
    const next = mergeAssistantText(messages, '新回复');
    assert.equal(next.length, 2);
    assert.equal(next[1]?.role, 'assistant');
  });
});

describe('乐观更新与列表', () => {
  it('用户消息立刻追加', () => {
    const next = appendUserMessage([], '发出去');
    assert.equal(next.length, 1);
    assert.equal(next[0]?.role, 'user');
  });

  it('**发图片时本地消息也要带 images**（否则图发出去就消失了）', () => {
    const img = { type: 'image' as const, dataUrl: 'data:image/png;base64,AAA', name: 'a.png' };
    const next = appendUserMessage([], '看这张图', [img]);
    assert.equal(next[0]?.images?.length, 1);
    assert.equal(next[0]?.images?.[0]?.dataUrl, img.dataUrl);
  });

  it('没有图片时不带 images 字段（不制造空数组）', () => {
    const next = appendUserMessage([], '纯文字');
    assert.equal(next[0]?.images, undefined);
  });

  it('空图片数组也不带字段', () => {
    const next = appendUserMessage([], '纯文字', []);
    assert.equal(next[0]?.images, undefined);
  });

  it('upsertExecutor 保持顺序并替换', () => {
    const a = executor({ id: 'a' });
    const b = executor({ id: 'b' });
    const list = upsertExecutor([a, b], executor({ id: 'a', status: 'done' }));
    assert.deepEqual(
      list.map((e) => `${e.id}:${e.status}`),
      ['a:done', 'b:running'],
    );
  });

  it('可见Agent：保留在跑的与最近结束的', () => {
    const list = [
      executor({ id: 'old', status: 'done', createdAt: 1 }),
      executor({ id: 'mid', status: 'done', createdAt: 2 }),
      executor({ id: 'run', status: 'running', createdAt: 3 }),
    ];
    const visible = visibleExecutors(list, 1);
    assert.deepEqual(visible.map((e) => e.id), ['mid', 'run']);
  });
});
