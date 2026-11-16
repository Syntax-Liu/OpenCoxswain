import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { admit, DEFAULT_SOURCES, strengthOf } from '../ticket/source.js';
import type { InboundEvent } from '../ticket/source.js';

/**
 * Source：事件来源与准入。
 *
 * ## 为什么需要（DSH docs/001-domain）
 *
 * > **来源** — 一条事件流。规则：**在机器人的自身消息和监听范围之外的
 * > 触发进入领域之前就丢弃它们。**
 * > 存在的原因：重启之后不能重放已处理的事件。
 *
 * ## 我们的痛点
 *
 * 四个入口（Web / IM / CLI / 定时）各自直接调 `userSays`，
 * 没有统一的地方回答"这条消息该不该接受"。
 *
 * **最要紧的一条**：不该进来的消息必须在**进上下文之前**丢掉——
 * 一旦进了，模型就会对它发言，用户看到一条无中生有的回复。
 */

const ev = (over: Partial<InboundEvent> = {}): InboundEvent => ({
  source: 'web',
  actor: 'local-user',
  text: '帮我看看这个',
  mentionsAgent: true,
  ...over,
});

describe('默认配置', () => {
  it('**IM 默认只接 @ 机器人的消息**', () => {
    // 群里所有话都进来会让 bot 变吵，还会对无关的话发言。
    // DSH 的哲学："尽可能少地占用人的注意力"。
    assert.equal(DEFAULT_SOURCES.im.scope, 'mention-only');
  });

  it('IM 默认是关闭的', () => {
    assert.equal(DEFAULT_SOURCES.im.enabled, false);
  });

  it('Web / CLI / 定时默认全收', () => {
    assert.equal(DEFAULT_SOURCES.web.scope, 'all');
    assert.equal(DEFAULT_SOURCES.cli.scope, 'all');
    assert.equal(DEFAULT_SOURCES.schedule.scope, 'all');
  });
});

describe('**准入：不该进的不进**', () => {
  it('来源关闭 → 拒绝', () => {
    const r = admit(ev({ source: 'im' }), DEFAULT_SOURCES.im);
    assert.equal(r.accept, false);
    assert.match(r.accept === false ? r.reason : '', /关闭/);
  });

  it('**mention-only 且没 @ → 拒绝**', () => {
    const r = admit(
      ev({ source: 'im', mentionsAgent: false }),
      { kind: 'im', scope: 'mention-only', enabled: true },
    );
    assert.equal(r.accept, false);
    assert.match(r.accept === false ? r.reason : '', /没提到它/);
  });

  it('mention-only 且 @ 了 → 接受', () => {
    const r = admit(
      ev({ source: 'im', mentionsAgent: true }),
      { kind: 'im', scope: 'mention-only', enabled: true },
    );
    assert.equal(r.accept, true);
  });

  it('scope=all 时不看 @ ', () => {
    const r = admit(ev({ mentionsAgent: false }), DEFAULT_SOURCES.web);
    assert.equal(r.accept, true);
  });

  it('空消息 → 拒绝', () => {
    assert.equal(admit(ev({ text: '   ' }), DEFAULT_SOURCES.web).accept, false);
  });

  it('**拒绝理由要说清是哪个来源**（方便排查）', () => {
    const r = admit(ev({ source: 'im' }), DEFAULT_SOURCES.im);
    assert.match(r.accept === false ? r.reason : '', /im/);
  });
});

describe('**授权强度由来源决定**', () => {
  it('Web 里用户说的 → explicit', () => {
    assert.equal(strengthOf(ev()), 'explicit');
  });

  it('IM 里 @ 了机器人 → explicit（他就是在叫它干活）', () => {
    assert.equal(strengthOf(ev({ source: 'im', mentionsAgent: true })), 'explicit');
  });

  it('**IM 群里没 @ 的跟帖 → inferred**', () => {
    // 模型得自己判断"这是不是要我做事"。
    assert.equal(strengthOf(ev({ source: 'im', mentionsAgent: false })), 'inferred');
  });

  it('定时/模板 → automatic', () => {
    assert.equal(strengthOf(ev({ source: 'schedule' })), 'automatic');
  });

  it('CLI → explicit', () => {
    assert.equal(strengthOf(ev({ source: 'cli' })), 'explicit');
  });
});
