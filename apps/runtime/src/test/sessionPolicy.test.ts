/**
 * Agent 会话复用策略。
 *
 * 核心约束：
 * 1. **用户明确要求高于一切判断**
 * 2. **复用不一定省钱**——旧会话太长时复用反而更贵
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_HOT_WINDOW_MS,
  DEFAULT_REUSE_TOKEN_LIMIT,
  decideSession,
  detectUserIntent,
  goalsRelated,
} from '../orchestrator/sessionPolicy.js';

const MIN = 60_000;
const now = 1_700_000_000_000;

const cand = (over: Partial<{
  sessionId: string;
  messageCount: number;
  tokens: number;
  lastActiveAt: number;
  lastGoal: string;
  succeeded: boolean;
}> = {}) => ({
  sessionId: 'd_1',
  messageCount: 20,
  tokens: 5000,
  lastActiveAt: now - 2 * MIN,
  lastGoal: '分析项目的 LaTeX 结构',
  succeeded: true,
  ...over,
});

const ctx = (over: Record<string, unknown> = {}) => ({
  candidates: [cand()],
  goal: '继续分析 LaTeX 结构',
  now,
  ...over,
});

describe('识别用户意图', () => {
  it('**"开新会话" → new**', () => {
    assert.equal(detectUserIntent('开个新会话做这个'), 'new');
    assert.equal(detectUserIntent('换一个对话'), 'new');
    assert.equal(detectUserIntent('从头开始'), 'new');
  });

  it('**"接着上次" → reuse**', () => {
    assert.equal(detectUserIntent('接着上次继续'), 'reuse');
    assert.equal(detectUserIntent('沿用之前的会话'), 'reuse');
    assert.equal(detectUserIntent('上次那个任务还没做完'), 'reuse');
  });

  it('没表态时返回 undefined', () => {
    assert.equal(detectUserIntent('分析一下这个项目'), undefined);
  });
});

describe('**用户明确要求优先**', () => {
  it('用户要新会话 → 即使其他条件都适合复用也新建', () => {
    const d = decideSession(ctx({ userWants: 'new' }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /你要求/);
  });

  it('用户要复用 → 即使任务不相关也复用', () => {
    const d = decideSession(
      ctx({ userWants: 'reuse', goal: '完全无关的另一个任务' }),
    );
    assert.equal(d.choice, 'reuse');
    assert.equal(d.sessionId, 'd_1');
  });

  it('用户要复用但没有候选 → 如实说明', () => {
    const d = decideSession(ctx({ userWants: 'reuse', candidates: [] }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /没有可用/);
  });
});

describe('**会话太冷不复用**', () => {
  it('超过 30 分钟的会话不推荐复用', () => {
    const d = decideSession(ctx({ candidates: [cand({ lastActiveAt: now - 45 * MIN })] }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /缓存已过期/);
  });

  it('窗口内的可以复用', () => {
    const d = decideSession(
      ctx({ candidates: [cand({ lastActiveAt: now - DEFAULT_HOT_WINDOW_MS + MIN })] }),
    );
    assert.equal(d.choice, 'reuse');
  });
});

describe('**会话太长不复用**（反直觉但重要）', () => {
  it('超过 30k token 的会话不推荐复用', () => {
    const d = decideSession(ctx({ candidates: [cand({ tokens: 50_000 })] }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /50k token/);
    assert.match(d.reason, /反而更贵/);
  });

  it('短会话可以复用', () => {
    const d = decideSession(ctx({ candidates: [cand({ tokens: DEFAULT_REUSE_TOKEN_LIMIT - 1000 })] }));
    assert.equal(d.choice, 'reuse');
  });
});

describe('任务相关性', () => {
  it('共享关键词算相关', () => {
    assert.equal(goalsRelated('分析项目的 LaTeX 结构', '继续分析 LaTeX 结构'), true);
  });

  it('完全不同算不相关', () => {
    assert.equal(goalsRelated('分析项目的 LaTeX 结构', '删除所有备份图片'), false);
  });

  it('英文关键词也认', () => {
    assert.equal(goalsRelated('fix judgeFailure test', 'rerun judgeFailure'), true);
  });

  it('不相关时不复用', () => {
    const d = decideSession(ctx({ goal: '删除所有备份图片' }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /不是一回事/);
  });
});

describe('第一次派活', () => {
  it('没有候选时新建，并说明原因', () => {
    const d = decideSession(ctx({ candidates: [] }));
    assert.equal(d.choice, 'new');
    assert.match(d.reason, /第一次/);
  });
});

describe('**每个决定都有理由**', () => {
  const cases = [
    ctx(),
    ctx({ userWants: 'new' }),
    ctx({ candidates: [] }),
    ctx({ candidates: [cand({ tokens: 99_000 })] }),
    ctx({ candidates: [cand({ lastActiveAt: now - 99 * MIN })] }),
    ctx({ goal: '完全无关' }),
  ];

  for (const [i, c] of cases.entries()) {
    it(`场景 ${i + 1} 有非空 reason`, () => {
      const d = decideSession(c);
      assert.ok(d.reason.length > 5, `场景 ${i + 1} 理由太短: "${d.reason}"`);
    });
  }
});

describe('候选选择', () => {
  it('**优先最近成功的**', () => {
    const d = decideSession(
      ctx({
        candidates: [
          cand({ sessionId: 'old', lastActiveAt: now - 8 * MIN }),
          cand({ sessionId: 'recent', lastActiveAt: now - 1 * MIN }),
        ],
      }),
    );
    assert.equal(d.sessionId, 'recent');
  });

  it('失败过的会话排在后面', () => {
    const d = decideSession(
      ctx({
        candidates: [
          cand({ sessionId: 'failed', succeeded: false, lastActiveAt: now - 1 * MIN }),
          cand({ sessionId: 'ok', succeeded: true, lastActiveAt: now - 5 * MIN }),
        ],
      }),
    );
    assert.equal(d.sessionId, 'ok');
  });
});
