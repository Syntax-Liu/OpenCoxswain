import assert from 'node:assert/strict';
import { allCss } from './_css.js';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { diffLines, toHunks } from '../components/diff.js';
import {
  CHAT_TAB_ID,
  changeTabTitle,
  closeTab,
  openTab,
  tabAfterClose,
} from '../components/mainTabs.js';
import type { MainTab } from '../components/mainTabs.js';

/**
 * 主区标签 + 改动页（照 DSH）。
 *
 * ## 用户的原话
 *
 * > 这一轮的改动，查 dsh 的代码吧，和 dsh 差太多了
 * > 既然做了，那就像 DSH 这样吧，侧边栏可以放多个页面
 *
 * 第一版我把 Diff 塞在右栏里（宽 320px），双栏对比根本没法读。
 * 现在改成：右栏只负责**选**，主区开标签看**对比**。
 */

const chat: MainTab = { id: CHAT_TAB_ID, kind: 'chat', title: '对话' };
const change1: MainTab = {
  id: 'change:exe_1',
  kind: 'change',
  title: changeTabTitle(1),
  executorId: 'exe_1',
};
const change2: MainTab = {
  id: 'change:exe_2',
  kind: 'change',
  title: changeTabTitle(2),
  executorId: 'exe_2',
};

describe('**主区标签**', () => {
  it('开标签追加到末尾', () => {
    const tabs = openTab([chat], change1);
    assert.equal(tabs.length, 2);
    assert.equal(tabs[1]?.id, 'change:exe_1');
  });

  it('**重复开同一个只留一个**', () => {
    // 否则点三次就有三个一样的标签，关起来很烦
    const once = openTab([chat], change1);
    const twice = openTab(once, change1);
    assert.equal(twice.length, 2);
  });

  it('关掉非当前标签，当前不变', () => {
    const tabs = [chat, change1, change2];
    assert.equal(tabAfterClose(tabs, 'change:exe_1', 'change:exe_2'), 'change:exe_2');
  });

  it('关掉当前标签 → 切到左边邻居', () => {
    const tabs = [chat, change1, change2];
    assert.equal(tabAfterClose(tabs, 'change:exe_2', 'change:exe_2'), 'change:exe_1');
  });

  it('关掉第一个可关的 → 切到右边邻居', () => {
    const tabs = [chat, change1];
    assert.equal(tabAfterClose(tabs, 'change:exe_1', 'change:exe_1'), CHAT_TAB_ID);
  });

  it('**对话标签不能关**', () => {
    // 总得有个落脚的地方
    const tabs = closeTab([chat, change1], CHAT_TAB_ID);
    assert.equal(tabs.length, 2);
  });

  it('关掉改动标签', () => {
    const tabs = closeTab([chat, change1], 'change:exe_1');
    assert.deepEqual(tabs.map((t) => t.id), [CHAT_TAB_ID]);
  });
});

describe('**hunk 分组**（照 git / DSH 的 @@ 头）', () => {
  const make = (n: number): string =>
    Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n');

  it('小改动只有 1 个 hunk，带 3 行上下文', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng';
    const after = 'a\nb\nc\nX\ne\nf\ng';
    const hunks = toHunks(diffLines(before, after));
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0]?.lines.length, 7);
  });

  it('**相隔很远的两处改动拆成两个 hunk**', () => {
    // 不拆的话：改两处、中间 20 行全铺出来，用户要滚屏才能看到第二处
    const before = make(30);
    const after = before.replace('line5', 'CHANGED5').replace('line25', 'CHANGED25');
    const hunks = toHunks(diffLines(before, after));
    assert.equal(hunks.length, 2);
  });

  it('hunk 头是 git 格式', () => {
    const hunks = toHunks(diffLines('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng'));
    assert.match(hunks[0]!.header, /^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  it('完全没变时没有 hunk', () => {
    assert.deepEqual(toHunks(diffLines('a\nb', 'a\nb')), []);
  });
});

describe('**改动页在主区，不在右栏**', () => {
  const changePage = readFileSync(
    new URL('../../src/components/ChangePage.tsx', import.meta.url),
    'utf8',
  );
  const panel = readFileSync(
    new URL('../../src/components/ChangesPanel.tsx', import.meta.url),
    'utf8',
  );
  const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it('右栏面板**不再**内联渲染 Diff', () => {
    // 第一版把 DiffView 塞在右栏，320px 宽根本读不了双栏
    assert.ok(!panel.includes('DiffView'), '右栏还在内联渲染 Diff');
  });

  it('右栏点击走 onOpenChanges', () => {
    assert.match(panel, /onOpenChanges/);
  });

  it('改动页有左侧文件列表 + 右侧 Diff', () => {
    assert.match(changePage, /change-files/, '缺文件列表');
    assert.match(changePage, /change-diff/, '缺 Diff 区');
  });

  it('布局是两栏网格', () => {
    const m = /\.change-body\s*\{([^}]*)\}/.exec(css);
    assert.ok(m, 'CSS 里没有 .change-body');
    assert.match(m[1] ?? '', /grid-template-columns/, '没有做左右分栏');
  });
});
