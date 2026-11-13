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
  decisionPanelTitle,
  isAckedDecision,
  isPendingDecision,
  pendingDecisions,
  summarizeDecision,
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

describe('标题', () => {
  it('给数量', () => {
    assert.equal(decisionPanelTitle(3), '3 件事等你决定');
    assert.equal(decisionPanelTitle(1), '1 件事等你决定');
  });

  it('0 条时返回空串（面板不显示）', () => {
    assert.equal(decisionPanelTitle(0), '');
  });
});
