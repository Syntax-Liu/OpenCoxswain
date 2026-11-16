import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluate } from '../ticket/eval.js';
import { createMandate, revalidate } from '../ticket/mandate.js';

/**
 * Eval：判断消息该怎么处理（对齐 DSH 的评估层）。
 *
 * ## 为什么需要
 *
 * 之前 Assistant 收到消息**直接行动**：
 *
 *   用户："算了，先这样"  → 当成新任务理解
 *   用户："谢谢"          → 也可能派活
 *
 * DSH 的评估层把这一步显式化：accept / stop / ignore / defer。
 */
describe('**停信号**', () => {
  it('「算了」在有任务跑时 → stop', () => {
    assert.equal(evaluate('算了', 2).decision, 'stop');
  });

  it('**没任务跑时不算停**（用户可能在说别的事）', () => {
    assert.equal(evaluate('算了', 0).decision, 'defer');
  });

  it('「停」「不用了」「先这样」都认', () => {
    for (const t of ['停', '停止', '不用了', '先这样', '不要了']) {
      assert.equal(evaluate(t, 1).decision, 'stop', `${t} 没被识别为停`);
    }
  });

  it('**长句里的"停"不算**（多半是提问）', () => {
    // "取消订阅后怎么恢复？" 含"取消"，但它是提问
    const r = evaluate('取消订阅后怎么恢复？', 2);
    assert.equal(r.decision, 'defer');
  });

  it('规则判定不花模型调用', () => {
    assert.equal(evaluate('算了', 1).byRule, true);
  });
});

/**
 * 客套话**照常回复**。
 *
 * ## 2026-11-16 用户实测后改的设计
 *
 * 原来判成 ignore（不回复）。用户反馈：
 *
 * > 用户说客套话，只需要让 Assistant 自己回复即可，但是实际测试之后，
 * > 发了"谢谢"会卡住，进入超长时间的等待。**不做 ignore 是因为
 * > 客套话是无限多的，ignore 做不完全，而且问题会有很多**。
 *
 * 三条都对：
 *   1. 不回复就是 bug —— 界面上你说了话却永远等不到回应
 *   2. 永远做不全 —— 「辛苦了」「麻烦了」「不错」列不完
 *   3. 误判代价大 —— 「好的」有时真是确认指令
 *
 * 现在只用来降噪：照常回复，但不派 Agent。
 */
describe('**客套话照常回复**', () => {
  it('「谢谢」「好的」「收到」不判 ignore', () => {
    for (const t of ['谢谢', '好的', '收到', 'ok', '嗯']) {
      assert.notEqual(evaluate(t, 0).decision, 'ignore', `${t} 被判成不回复了`);
    }
  });

  it('交给 Assistant 正常回应，byRule=true', () => {
    const r = evaluate('谢谢', 0);
    assert.equal(r.decision, 'defer');
    assert.equal(r.byRule, true);
  });

  it('理由里说明不要派活', () => {
    assert.match(evaluate('谢谢', 0).reason, /不要派 Agent/);
  });

  it('带标点也认', () => {
    assert.equal(evaluate('谢谢！', 0).byRule, true);
    assert.equal(evaluate('好的。', 0).byRule, true);
  });
});

describe('**继续现有任务**', () => {
  it('有任务在跑时「继续」→ defer（交给 Assistant 判断发给哪个）', () => {
    assert.equal(evaluate('继续', 1).decision, 'defer');
    assert.equal(evaluate('接着做', 1).decision, 'defer');
  });
});

describe('**规则判不了就交出去**', () => {
  it('普通指令 defer，byRule=false', () => {
    const r = evaluate('帮我把这个文件删了', 0);
    assert.equal(r.decision, 'defer');
    assert.equal(r.byRule, false, '这是交给模型的，不是规则判的');
  });

  it('**不靠关键词猜意图**（分类错了比不做更糟）', () => {
    // "你好" 不该被规则判成"新任务"，也不该被判成"忽略"
    assert.equal(evaluate('你好', 0).decision, 'defer');
  });

  it('空消息 → ignore', () => {
    assert.equal(evaluate('   ', 0).decision, 'ignore');
  });
});

/**
 * Mandate：授权快照。
 *
 * ## 为什么需要（DSH docs/001-domain）
 *
 * > 授权是**不可变**的：范围更宽意味着新建一个工单。
 *
 * ## 我们之前的问题
 *
 * 权限档位是**动作级**的：每次工具调用现查全局值。
 * 于是用户跑到一半改权限，**正在跑的任务也会跟着换规则**。
 * 用户以为改的是"以后"，实际影响当下 —— 这是最容易被忽略的越权。
 */
describe('授权快照', () => {
  it('创建时定格了档位和写域', () => {
    const m = createMandate({
      level: 'manual',
      scope: ['src/auth'],
      strength: 'explicit',
      grantedBy: 'user',
      policyVersion: 3,
      now: 1000,
    });
    assert.equal(m.level, 'manual');
    assert.deepEqual(m.scope, ['src/auth']);
    assert.equal(m.strength, 'explicit');
    assert.equal(m.policyVersion, 3);
    assert.equal(m.grantedAt, 1000);
  });

  it('**scope 是拷贝**（外面改数组不影响快照）', () => {
    const scope = ['a'];
    const m = createMandate({
      level: 'auto',
      scope,
      strength: 'inferred',
      grantedBy: 'assistant',
      policyVersion: 1,
    });
    scope.push('b');
    assert.deepEqual(m.scope, ['a'], '快照不该跟着原数组变');
  });
});

describe('授权重新校验', () => {
  const base = createMandate({
    level: 'auto',
    scope: [],
    strength: 'inferred',
    grantedBy: 'assistant',
    policyVersion: 1,
  });

  it('版本没变 → 仍然有效', () => {
    assert.equal(revalidate(base, { level: 'auto', policyVersion: 1 }).stillValid, true);
  });

  it('**权限收紧 → 失效**（要继续得用户重新确认）', () => {
    const r = revalidate(base, { level: 'manual', policyVersion: 2 });
    assert.equal(r.stillValid, false);
    assert.match(r.reason ?? '', /收紧/, '要说清是收紧，不是"变了"');
  });

  it('**权限放松 → 仍有效**（放松不该中断在跑的任务）', () => {
    assert.equal(revalidate(base, { level: 'full', policyVersion: 2 }).stillValid, true);
  });

  it('readonly 最严：auto 降到 readonly 要重新确认', () => {
    const r = revalidate(base, { level: 'readonly', policyVersion: 5 });
    assert.equal(r.stillValid, false);
  });
});
