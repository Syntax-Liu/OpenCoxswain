/**
 * 消息操作测试。
 *
 * 核心约束：**不同角色能做的操作不一样**。
 * 给用户消息加"重试"、给它加"编辑"，都是错的——
 * 那会让人以为可以改别人的话。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { actionsFor, editableText } from '../components/messageCapabilities.js';

describe('Assistant 消息', () => {
  it('可以重试', () => {
    assert.equal(actionsFor({ role: 'assistant', content: '答案' }).canRetry, true);
  });

  it('**不能编辑**（那是它说的话，不是用户说的）', () => {
    assert.equal(actionsFor({ role: 'assistant', content: '答案' }).canEdit, false);
  });

  it('可以复制', () => {
    assert.equal(actionsFor({ role: 'assistant', content: '答案' }).canCopy, true);
  });

  it('空内容不能复制', () => {
    assert.equal(actionsFor({ role: 'assistant', content: '   ' }).canCopy, false);
  });
});

describe('用户消息', () => {
  it('可以编辑', () => {
    assert.equal(actionsFor({ role: 'user', content: '问题' }).canEdit, true);
  });

  it('可以重发', () => {
    assert.equal(actionsFor({ role: 'user', content: '问题' }).canResend, true);
  });

  it('**不能重试**（重试是"让它重新回答"，只对回答有意义）', () => {
    assert.equal(actionsFor({ role: 'user', content: '问题' }).canRetry, false);
  });
});

describe('内部通知', () => {
  const internal = { role: 'user' as const, content: '【执行者结算】...', source: 'internal:executor' };

  it('**什么操作都没有，除了复制**', () => {
    const a = actionsFor(internal);
    assert.equal(a.canRetry, false);
    assert.equal(a.canEdit, false);
    assert.equal(a.canResend, false);
    assert.equal(a.canCopy, true);
  });

  it('识别 internal: 前缀', () => {
    assert.equal(actionsFor({ role: 'assistant', content: 'x', source: 'internal:agent' }).canRetry, false);
  });

  it('普通 source 不受影响', () => {
    assert.equal(actionsFor({ role: 'assistant', content: 'x', source: 'assistant' }).canRetry, true);
  });
});

describe('其它角色', () => {
  it('system / tool 消息不提供重试与编辑', () => {
    for (const role of ['system', 'tool'] as const) {
      const a = actionsFor({ role, content: '内容' });
      assert.equal(a.canRetry, false);
      assert.equal(a.canEdit, false);
      assert.equal(a.canCopy, true);
    }
  });
});

describe('编辑时去掉附件内容', () => {
  it('**只留用户自己打的字**', () => {
    const content =
      '看一下这个接口\n\n【附件：api.ts】\n```\nexport function f() {}\n```';
    assert.equal(editableText(content), '看一下这个接口');
  });

  it('多个附件也都能去掉', () => {
    const content = '解释这两个\n\n【附件：a.ts】\n```\na\n```\n\n【附件：b.ts】\n```\nb\n```';
    assert.equal(editableText(content), '解释这两个');
  });

  it('没有附件时原样返回', () => {
    assert.equal(editableText('就是一句话'), '就是一句话');
  });

  it('只剩附件时退回原文（总比空着好）', () => {
    const content = '【附件：x.ts】\n```\nx\n```';
    assert.ok(editableText(content).length > 0);
  });
});
