/**
 * 输入区提示测试。
 *
 * 核心约束：**空闲时什么都不显示**。
 * 一个永远挂着的提示框，比不提示更占地方。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { composerHint } from '../components/composerHint.js';

describe('空闲', () => {
  it('**空闲时不显示任何提示**', () => {
    assert.equal(composerHint({ thinking: false, runningAgents: 0 }), null);
  });
});

describe('有 Agent 在跑', () => {
  it('显示数量', () => {
    const hint = composerHint({ thinking: true, runningAgents: 3 });
    assert.ok(hint !== null);
    assert.match(hint.text, /3 个 Agent/);
  });

  it('**明确说"不会打断"**（这是用户最担心的）', () => {
    const hint = composerHint({ thinking: true, runningAgents: 2 });
    assert.match(hint!.text, /不打断|不会打断/);
  });

  it('说清新消息会排队', () => {
    const hint = composerHint({ thinking: true, runningAgents: 1 });
    assert.match(hint!.text, /排队/);
  });

  it('比思考中更醒目（有 Agent 在跑才真正需要提醒）', () => {
    const withAgents = composerHint({ thinking: true, runningAgents: 1 });
    const onlyThinking = composerHint({ thinking: true, runningAgents: 0 });
    assert.equal(withAgents?.tone, 'active');
    assert.equal(onlyThinking?.tone, 'quiet');
  });
});

describe('只有 Assistant 在想', () => {
  it('也提示可以继续说', () => {
    const hint = composerHint({ thinking: true, runningAgents: 0 });
    assert.ok(hint !== null);
    assert.match(hint.text, /继续说/);
  });

  it('语气安静（不是警报）', () => {
    assert.equal(composerHint({ thinking: true, runningAgents: 0 })?.tone, 'quiet');
  });
});

describe('边界', () => {
  it('负数当空闲处理', () => {
    assert.equal(composerHint({ thinking: false, runningAgents: -1 }), null);
  });

  it('文案简短（不会占太多地方）', () => {
    const hint = composerHint({ thinking: true, runningAgents: 3 });
    assert.ok((hint?.text.length ?? 0) < 60, '提示太长会占地方');
  });
});
