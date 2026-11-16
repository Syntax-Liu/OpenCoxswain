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

/**
 * 定稿**不能直接清空**缓冲。
 *
 * ## 2026-11-16 实测踩到的
 *
 * 第一次实现是 `streaming: ''`——结果用户看到的是：
 *
 * > 似乎仍然是整段蹦出来的
 *
 * 前端采样证实：t=0.8s 时流式气泡出现了（长度 15），
 * 下一帧就消失（-2 = 没有流式气泡），之后一直不出现。
 *
 * 原因：`assistant_text` 是**每一步**都发（含调工具前那一步），
 * 不是"整轮结束"。拿它当定稿信号，一个字刚流出来就被清掉。
 *
 * 现在：定稿进 messages，`streaming` 里只扣掉**已定稿的那部分**，
 * 剩下的继续显示，下一步的 delta 接着往上加。
 */
describe('**定稿只扣掉已定稿的部分**', () => {
  it('缓冲和定稿完全相等时清空', () => {
    let s: AppState = { ...initialState, currentProjectId: 'p1', streaming: '你好呀' };
    s = apply(s, { type: 'assistant_text', projectId: 'p1', text: '你好呀' } as RuntimeEventDto);
    assert.equal(s.streaming, '', '内容已经完全定稿，缓冲该清空');
  });

  it('**缓冲比定稿长时保留剩余**（下一步还在写）', () => {
    let s: AppState = {
      ...initialState,
      currentProjectId: 'p1',
      streaming: '我先说明一下。接下来我去查文件',
    };
    s = apply(s, {
      type: 'assistant_text',
      projectId: 'p1',
      text: '我先说明一下。',
    } as RuntimeEventDto);
    assert.equal(
      s.streaming,
      '接下来我去查文件',
      '已经定稿那部分要扣掉，新写的要留着继续显示',
    );
  });

  it('对不上的情况不清空（保守）', () => {
    let s: AppState = { ...initialState, currentProjectId: 'p1', streaming: '完全不同的内容' };
    s = apply(s, { type: 'assistant_text', projectId: 'p1', text: '别的' } as RuntimeEventDto);
    assert.equal(s.streaming, '完全不同的内容', '对不上就别乱清');
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
