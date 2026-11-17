/**
 * 失败信息三要素（UD-06）。
 *
 * 来源：[design-research/03-agent-ui-problems.md D2](https://github.com/Syntax-Liu/OpenCoxswain)
 *
 * 用户看到一行"出错了"时，真正想知道的是三件事：
 *
 * 1. 发生了什么   → `title`
 * 2. **保留了什么** → `preserved`（本次新增）
 * 3. 怎么继续     → `retry`
 *
 * 这里守的是**不编造**：环境问题重试没用，就不能给"重试"；
 * 没有可靠信息时 `preserved` 必须是 undefined，而不是一句空话。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyError, ERROR_KIND_LABEL } from '../components/errorDisplay.js';

describe('**每条都给出"保留了什么"或明确不给**', () => {
  it('临时性问题：明确告诉用户改动还在', () => {
    const e = classifyError('rate limit exceeded');
    assert.equal(e.kind, 'self-recoverable');
    assert.ok(e.preserved, '临时性问题必须告诉用户东西没丢');
    assert.match(e.preserved, /保存/);
  });

  it('**环境问题不给"保留了什么"**——那会儿还没开始干活，说了就是空话', () => {
    const e = classifyError('ENOENT: no such file or directory');
    assert.equal(e.kind, 'environment');
    assert.equal(e.preserved, undefined);
  });

  it('需要人拍板：改动已保存，在等你', () => {
    const e = classifyError('等待批准');
    assert.equal(e.kind, 'needs-user');
    assert.ok(e.preserved);
  });
});

describe('**"怎么继续"要和错误性质匹配**', () => {
  it('临时性问题 → 真的能重试', () => {
    const e = classifyError('timeout');
    assert.equal(e.retry?.kind, 'retry');
    assert.equal(e.retry?.label, '重试');
  });

  it('**环境问题 → 不是"重试"**（重试还是同样的错，会骗用户反复点）', () => {
    const e = classifyError('permission denied');
    assert.equal(e.kind, 'environment');
    assert.notEqual(e.retry?.kind, 'retry', '环境问题不能给重试按钮');
    assert.match(e.retry?.label ?? '', /修好|重新/);
  });

  it('需要人处理 → 去处理，不是重试', () => {
    const e = classifyError('api key invalid');
    assert.equal(e.kind, 'needs-user');
    assert.notEqual(e.retry?.kind, 'retry');
  });
});

describe('**分类本身仍然可靠**', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['ENOENT', 'environment'],
    ['permission denied', 'environment'],
    ['429 rate limit', 'self-recoverable'],
    ['502 bad gateway', 'self-recoverable'],
    ['401 unauthorized', 'needs-user'],
    ['等待批准', 'needs-user'],
  ];

  for (const [message, expected] of cases) {
    it(`"${message}" → ${expected}`, () => {
      assert.equal(classifyError(message).kind, expected);
    });
  }

  it('未知错误默认归到「需要你」，不假装能自动解决', () => {
    assert.equal(classifyError('some totally unknown failure').kind, 'needs-user');
  });

  it('空消息不炸', () => {
    assert.doesNotThrow(() => classifyError(''));
  });
});

describe('**展示用的短标签齐全**', () => {
  it('三类都有中文标签', () => {
    for (const kind of ['self-recoverable', 'needs-user', 'environment'] as const) {
      assert.ok(ERROR_KIND_LABEL[kind], `${kind} 缺标签`);
    }
  });
});
