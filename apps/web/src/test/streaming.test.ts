import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyEvent, initialState } from '../state.js';
import type { AppState } from '../state.js';
import type { RuntimeEventDto } from '../api.js';

/**
 * 流式输出。
 *
 * ## 2026-11-16 用户实测
 *
 * > A1：整一段一次性蹦出
 * > A3：不能在我发送第一条的时候马上回复（即使不能马上回复
 * >     也应该留个对话框占个位）
 *
 * 原来 `chat` 等整段生成完才返回，用户对着空屏幕等几十秒。
 *
 * ## 现在的链路
 *
 * ```
 * 模型 SSE chunk
 *   → chatStream onDelta
 *   → runLoop onDelta
 *   → RuntimeEvent 'assistant_delta'
 *   → SSE bus
 *   → 前端 state.streaming 累加
 *   → 气泡里逐字出现 + 光标
 * ```
 *
 * `assistant_text`（定稿）到达时清空 streaming，
 * 真正的消息进 messages——**不重复显示**。
 */

let seq = 0;

/**
 * 应用一个事件。
 *
 * **seq 必须递增**：applyEvent 用它去重（重连补发时会重复）。
 * 固定传同一个值的话，第二次开始全被当成"已应用过"丢掉。
 */
function apply(state: AppState, event: RuntimeEventDto): AppState {
  seq += 1;
  return applyEvent(state, seq, event);
}

describe('**流式累加**', () => {
  it('多个 delta 拼起来', () => {
    let s: AppState = { ...initialState, currentProjectId: 'p1' };
    s = apply(s, { type: 'assistant_delta', projectId: 'p1', text: '你' } as RuntimeEventDto);
    s = apply(s, { type: 'assistant_delta', projectId: 'p1', text: '好' } as RuntimeEventDto);
    s = apply(s, { type: 'assistant_delta', projectId: 'p1', text: '呀' } as RuntimeEventDto);
    assert.equal(s.streaming, '你好呀');
  });

  it('**第一个 delta 就把 thinking 关掉**（字已经在长了）', () => {
    const s = apply(
      { ...initialState, thinking: true, currentProjectId: 'p1' },
      { type: 'assistant_delta', projectId: 'p1', text: '嗯' } as RuntimeEventDto,
    );
    assert.equal(s.thinking, false);
    assert.equal(s.streaming, '嗯');
  });

  it('别的项目的 delta 不影响当前项目', () => {
    const s = apply(
      { ...initialState, currentProjectId: 'p1' },
      { type: 'assistant_delta', projectId: 'p2', text: '不该进来' } as RuntimeEventDto,
    );
    assert.equal(s.streaming, '');
  });
});

describe('**定稿后清空**', () => {
  it('assistant_text 到达时 streaming 清掉（不重复显示）', () => {
    let s: AppState = { ...initialState, currentProjectId: 'p1', streaming: '你好呀' };
    s = apply(s, { type: 'assistant_text', projectId: 'p1', text: '你好呀' } as RuntimeEventDto);
    assert.equal(s.streaming, '', '定稿后必须清空，否则同一段字显示两遍');
  });

  it('定稿的内容进 messages', () => {
    let s: AppState = { ...initialState, currentProjectId: 'p1', streaming: '草稿' };
    s = apply(s, { type: 'assistant_text', projectId: 'p1', text: '正式回复' } as RuntimeEventDto);
    assert.ok(
      s.messages.some((m) => m.content.includes('正式回复')),
      '定稿文本没进消息列表',
    );
  });

  it('thinking 也清掉', () => {
    const s = apply(
      { ...initialState, currentProjectId: 'p1', thinking: true, streaming: 'x' },
      { type: 'assistant_text', projectId: 'p1', text: 'x' } as RuntimeEventDto,
    );
    assert.equal(s.thinking, false);
  });
});

describe('**空 delta 不产生空气泡**', () => {
  it('没收到任何 delta 时 streaming 是空串', () => {
    assert.equal(initialState.streaming, '');
  });

  it('空串 delta 保持空串', () => {
    const s = apply(
      { ...initialState, currentProjectId: 'p1' },
      { type: 'assistant_delta', projectId: 'p1', text: '' } as RuntimeEventDto,
    );
    assert.equal(s.streaming, '');
  });
});
