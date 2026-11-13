/**
 * 待决策面板的逻辑。
 *
 * 核心约束：**只把真正需要用户拍板的东西列出来**。
 *
 * 半自动自进化的 S3 是"人只参与重大决策"。这个面板就是那个介入点——
 * 如果它把普通汇报也混进来，用户就会被噪音淹没，介入点就失效了。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DECISION_VISIBLE_LIMIT,
  decisionPanelTitle,
  hiddenDecisionCount,
  isAckedDecision,
  isPendingDecision,
  pendingDecisions,
  stripMarkdown,
  summarizeDecision,
  visibleDecisions,
} from '../components/decisions.js';
import type { ReportDto } from '../api.js';

const report = (over: Partial<ReportDto>): ReportDto =>
  ({
    id: 'r1',
    projectId: 'p1',
    executorId: null,
    kind: 'progress',
    body: '正文',
    needsUser: false,
    at: 1000,
    ackedAt: null,
    ...over,
  }) as ReportDto;

describe('判定待决策', () => {
  it('**needsUser 且未处理 → 待决策**', () => {
    assert.equal(isPendingDecision(report({ needsUser: true })), true);
  });

  it('**普通进度不算**（不能混进来制造噪音）', () => {
    assert.equal(isPendingDecision(report({ needsUser: false })), false);
  });

  it('**已处理的不再出现**', () => {
    assert.equal(isPendingDecision(report({ needsUser: true, ackedAt: 2000 })), false);
  });

  it('已处理的不算"已确认决策"以外的任何东西', () => {
    assert.equal(isAckedDecision(report({ needsUser: true, ackedAt: 2000 })), true);
  });
});

describe('列表', () => {
  it('**最新的排最前**', () => {
    const list = pendingDecisions([
      report({ id: 'old', needsUser: true, at: 1000 }),
      report({ id: 'new', needsUser: true, at: 3000 }),
      report({ id: 'mid', needsUser: true, at: 2000 }),
    ]);
    assert.deepEqual(
      list.map((d) => d.id),
      ['new', 'mid', 'old'],
    );
  });

  it('过滤掉不需要用户的和已处理的', () => {
    const list = pendingDecisions([
      report({ id: 'a', needsUser: true }),
      report({ id: 'b', needsUser: false }),
      report({ id: 'c', needsUser: true, ackedAt: 9 }),
    ]);
    assert.deepEqual(
      list.map((d) => d.id),
      ['a'],
    );
  });

  it('空列表不崩', () => {
    assert.deepEqual(pendingDecisions([]), []);
  });

  it('保留正文和来源', () => {
    const [d] = pendingDecisions([
      report({ needsUser: true, body: '用方案 A 还是 B？', executorId: 'exe_1' }),
    ]);
    assert.equal(d?.body, '用方案 A 还是 B？');
    assert.equal(d?.executorId, 'exe_1');
  });
});

describe('摘要', () => {
  it('**多行压成一行**', () => {
    assert.equal(summarizeDecision('第一行\n\n第二行'), '第一行 第二行');
  });

  it('过长时截断并加省略号', () => {
    const out = summarizeDecision('x'.repeat(200), 20);
    assert.equal(out.length, 20);
    assert.ok(out.endsWith('…'));
  });

  it('短的保持原样', () => {
    assert.equal(summarizeDecision('简短'), '简短');
  });
});

describe('**摘要必须剥掉 Markdown 标记**', () => {
  it('粗体标记不漏出来', () => {
    // 真实 bug：面板上显示成 "**结论**：任务 2–5 全部跑完"
    assert.equal(
      summarizeDecision('**结论**：任务 2–5 全部跑完'),
      '结论：任务 2–5 全部跑完',
    );
  });

  it('标题符号不漏出来', () => {
    assert.equal(
      summarizeDecision('## 结论 我倾向 **先做 B**'),
      '结论 我倾向 先做 B',
    );
  });

  it('行内代码去掉反引号', () => {
    assert.equal(summarizeDecision('改 `undo-test.txt` 这个文件'), '改 undo-test.txt 这个文件');
  });

  it('列表符号去掉', () => {
    assert.equal(stripMarkdown('- 第一条\n- 第二条'), '第一条 第二条');
    assert.equal(stripMarkdown('1. 第一条\n2. 第二条'), '第一条 第二条');
  });

  it('代码块整体去掉（摘要里没有意义）', () => {
    assert.equal(stripMarkdown('看这段：\n```\ncode here\n```\n完毕'), '看这段： 完毕');
  });

  it('引用符号去掉', () => {
    assert.equal(stripMarkdown('> 这是引用'), '这是引用');
  });
});

describe('**面板数量要限**', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({
    id: `d${i}`,
    projectId: 'p',
    body: `决策 ${i}`,
    at: 6000 - i * 1000,
    executorId: null,
  }));

  it('默认只显示前 3 条（不让面板压垮主区域）', () => {
    assert.equal(DECISION_VISIBLE_LIMIT, 3);
    assert.equal(visibleDecisions(many).length, 3);
  });

  it('**显示最新的**（排在前面的是最要紧的）', () => {
    const shown = visibleDecisions(many);
    assert.equal(shown[0]?.id, 'd0', 'at=6000 最新');
  });

  it('展开后显示全部', () => {
    assert.equal(visibleDecisions(many, true).length, 6);
  });

  it('给出被折叠的数量', () => {
    assert.equal(hiddenDecisionCount(many), 3);
    assert.equal(hiddenDecisionCount(many, true), 0);
  });

  it('不足 3 条时不提示折叠', () => {
    assert.equal(hiddenDecisionCount(many.slice(0, 2)), 0);
  });
});

describe('标题', () => {
  it('给数量', () => {
    assert.equal(decisionPanelTitle(3), '3 件事等你决定');
    assert.equal(decisionPanelTitle(1), '1 件事等你决定');
  });

  it('0 条时返回空串（面板不显示）', () => {
    assert.equal(decisionPanelTitle(0), '');
  });
});
