/**
 * 失败后的出路（UD-03 的替代方案）。
 *
 * ## 为什么这里没有「重试这一步」
 *
 * 查证结论：runtime 只有**文件快照**（`snapshot.ts`），
 * 没有对话上下文与循环状态的版本化。`Checkpoint` 是
 * 「一批文件改动的时间窗」，不是「可恢复的执行状态」。
 *
 * 带全量历史重跑会让模型看到一个自相矛盾的世界：
 * 文件是旧的，但它记得自己已经改过了。**那是幻觉，不是重试。**
 *
 * 所以这里只做一件事：**如实列出当前能做什么**。
 *
 * 核心断言：**不可用的选项不出现，而不是出现一个灰按钮**。
 * 灰按钮会被误解成"以后会可用"，隐藏更诚实。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoveryOptions } from '../components/recoveryOptions.js';

/** 从选项里取出 kind 列表，便于断言。 */
const kinds = (opts: readonly { kind: string }[]): string[] => opts.map((o) => o.kind);

describe('**只返回真正可用的选项**', () => {
  it('什么条件都不满足 → 只剩「重新说一次」', () => {
    const opts = recoveryOptions({ hasReversibleEffects: false, canResume: false });
    assert.deepEqual(kinds(opts), ['resend']);
  });

  it('有可撤销改动 → 出现「回滚改动」', () => {
    const opts = recoveryOptions({ hasReversibleEffects: true, canResume: false });
    assert.deepEqual(kinds(opts), ['rollback', 'resend']);
  });

  it('可续聊 → 出现「接着跟它说」', () => {
    const opts = recoveryOptions({ hasReversibleEffects: false, canResume: true });
    assert.deepEqual(kinds(opts), ['ask', 'resend']);
  });

  it('两者都满足 → 三个都在，且回滚排最前（最能挽回损失）', () => {
    const opts = recoveryOptions({ hasReversibleEffects: true, canResume: true });
    assert.deepEqual(kinds(opts), ['rollback', 'ask', 'resend']);
  });
});

describe('**「重新说一次」永远可用**', () => {
  it('任何组合下都包含 resend', () => {
    for (const hasReversibleEffects of [true, false]) {
      for (const canResume of [true, false]) {
        const opts = recoveryOptions({ hasReversibleEffects, canResume });
        assert.ok(
          kinds(opts).includes('resend'),
          `组合 ${hasReversibleEffects}/${canResume} 丢了 resend`,
        );
      }
    }
  });
});

describe('**不出现「从第 N 步重试」**', () => {
  it('没有任何选项声称能回到某一步', () => {
    const opts = recoveryOptions({ hasReversibleEffects: true, canResume: true });
    for (const o of opts) {
      assert.doesNotMatch(o.label, /第\s*\d+\s*步|重试这一步/, `不该出现：${o.label}`);
    }
  });

  it('三个选项的文案都描述了真实行为', () => {
    const opts = recoveryOptions({ hasReversibleEffects: true, canResume: true });
    const byKind = new Map(opts.map((o) => [o.kind, o]));
    // 回滚说的是"文件"，不是"撤销对话"
    assert.match(byKind.get('rollback')?.hint ?? '', /文件/);
    // 重新发起明确说是"新一轮"
    assert.match(byKind.get('resend')?.hint ?? '', /新一轮|重新/);
  });

  it('每个选项都有 label 与 hint（不许出现无说明的按钮）', () => {
    for (const o of recoveryOptions({ hasReversibleEffects: true, canResume: true })) {
      assert.ok(o.label.length > 0, `${o.kind} 缺 label`);
      assert.ok(o.hint.length > 0, `${o.kind} 缺 hint`);
    }
  });
});
