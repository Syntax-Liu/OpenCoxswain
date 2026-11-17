/**
 * 滚动跟随 / 冻结（UD-08）。
 *
 * 来源：[design-research/03-agent-ui-problems.md E2](https://github.com/Syntax-Liu/OpenCoxswain)
 *
 * > 用户在往上翻历史消息，新内容一来就被拽回底部。
 *
 * `useAutoScroll` 的三种触发条件（消息数、流式长度、会话切换）此前**只做了
 * 静态字符串匹配**（`uxFixes.test.ts` 检查参数有没有传），
 * 等于只验了"接线"，没验"逻辑"。这里补上真正的行为。
 *
 * ## 为什么不渲染 hook
 *
 * 项目测试基础设施明确回避渲染：`scripts/lib/browser.mjs` 的注释写着
 * happy-dom + React 18 下受控组件不可靠，写出来的测试时过时不过。
 * 所以把计算抽成纯函数来测——这也是 `computeAtBottom` 存在的理由。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeAtBottom, nextUnread } from '../components/useAutoScroll.js';

/** 造一个"可滚动区域"的参数组合。 */
const viewport = (scrollTop: number, scrollHeight = 2000, clientHeight = 600) =>
  [scrollTop, scrollHeight, clientHeight] as const;

describe('**是否贴底：阈值 80px**', () => {
  it('完全在底部 → 贴底', () => {
    // 2000 - 1400 - 600 = 0
    assert.equal(computeAtBottom(...viewport(1400)), true);
  });

  it('差 80px 以内 → 仍算贴底（留一点容差，避免抖动）', () => {
    // 距离 80
    assert.equal(computeAtBottom(...viewport(1320)), true);
  });

  it('差 81px → 不算贴底', () => {
    // 距离 81
    assert.equal(computeAtBottom(...viewport(1319)), false);
  });

  it('用户上翻到很远的地方 → 不贴底', () => {
    assert.equal(computeAtBottom(...viewport(0)), false);
  });

  it('内容比视口还短（不可滚）→ 视为贴底', () => {
    // scrollHeight 500 < clientHeight 600，距离为负
    assert.equal(computeAtBottom(0, 500, 600), true);
  });
});

describe('**新消息到达时的未读数**', () => {
  it('贴底时来新消息 → 不计未读（用户就在看）', () => {
    assert.equal(nextUnread(0, 3, true), 0);
    assert.equal(nextUnread(5, 2, true), 0, '切回底部时应清零');
  });

  it('上翻时来新消息 → 累加', () => {
    assert.equal(nextUnread(0, 1, false), 1);
    assert.equal(nextUnread(1, 1, false), 2);
    assert.equal(nextUnread(2, 5, false), 7);
  });

  it('没有新消息（delta=0）时保持原值', () => {
    assert.equal(nextUnread(3, 0, false), 3);
  });

  it('delta 为负（消息被删）时不清零也不变负', () => {
    assert.equal(nextUnread(3, -2, false), 3);
  });
});

describe('**核心场景：上翻看历史时不被拽回底部**', () => {
  /**
   * 完整模拟一次：
   * 用户贴底 → 上翻 → 来 3 条消息 → 用户回到底部
   */
  it('上翻期间连续来消息，未读一直累加，回到已读后清零', () => {
    const scrollHeight = 2000;
    const clientHeight = 600;
    const maxScroll = scrollHeight - clientHeight; // 1400

    // 1. 一开始贴底
    assert.equal(computeAtBottom(maxScroll, scrollHeight, clientHeight), true);
    let unread = nextUnread(0, 1, true);
    assert.equal(unread, 0);

    // 2. 用户上翻到中间（不贴底）
    const userScrollTop = 400;
    const atBottomWhileReading = computeAtBottom(userScrollTop, scrollHeight, clientHeight);
    assert.equal(atBottomWhileReading, false, '上翻后不该算贴底');

    // 3. 期间来了 3 条消息——都不能把视图拽走，只累计未读
    unread = nextUnread(unread, 1, atBottomWhileReading);
    unread = nextUnread(unread, 1, atBottomWhileReading);
    unread = nextUnread(unread, 1, atBottomWhileReading);
    assert.equal(unread, 3);

    // 4. 用户点"回到底部"
    const backAtBottom = computeAtBottom(maxScroll, scrollHeight, clientHeight);
    assert.equal(backAtBottom, true);
    unread = nextUnread(unread, 0, backAtBottom);
    assert.equal(unread, 0, '回到已读后未读必须清零');
  });
});
