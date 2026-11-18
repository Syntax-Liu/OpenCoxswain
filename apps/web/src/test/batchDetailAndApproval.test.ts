/**
 * 完成态摘要（UD-02 中间层）与首次提示（UD-05）。
 *
 * 两者共同的原则：**只用真实数据，拿不到就不显示**。
 * 参考 A3（消息折叠）/ B5（审批不遮挡）两条设计约束。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutorDto } from '../api.js';
import { describeTaskDetail } from '../components/batches.js';
import { firstTimeNote, markNoteSeen, resetSeen } from '../components/approvalImpact.js';

function agent(over: Partial<ExecutorDto> = {}): ExecutorDto {
  return {
    id: 'e1',
    projectId: 'p1',
    sessionId: 's1',
    label: 'Agent',
    goal: 'g',
    writeScope: [],
    status: 'done',
    summary: null,
    blockedReason: null,
    createdAt: 0,
    endedAt: 1000,
    ...over,
  };
}

describe('**完成态摘要：只用已有数据**', () => {
  it('有步数就显示步数', () => {
    const d = describeTaskDetail(agent({ metrics: { steps: 12 } as never }));
    assert.equal(d, '12 步');
  });

  it('有文件数和步数时两个都显示', () => {
    const d = describeTaskDetail(agent({ metrics: { steps: 12 } as never }), 3);
    assert.equal(d, '3 个文件 · 12 步');
  });

  it('**拿不到文件数就只说步数**，不写「0 个文件」', () => {
    const d = describeTaskDetail(agent({ metrics: { steps: 5 } as never }));
    assert.equal(d, '5 步');
    assert.ok(!String(d).includes('0 个文件'));
  });

  it('运行中不显示摘要（还没结束，谈不上干了多少）', () => {
    const d = describeTaskDetail(
      agent({ endedAt: null, status: 'running', metrics: { steps: 3 } as never }),
    );
    assert.equal(d, null);
  });

  it('什么都没干（步数 0、无文件数）→ 不显示，而不是显示空字符串', () => {
    assert.equal(describeTaskDetail(agent({ metrics: { steps: 0 } as never })), null);
  });

  it('没有 metrics 也不炸', () => {
    assert.equal(describeTaskDetail(agent()), null);
  });
});

describe('**首次提示：只对高影响动作，且只一次**', () => {
  // localStorage 在 node 测试环境里不存在 → 模块会退化为"每次都提示"。
  // 这里验证的是纯逻辑部分（类别过滤与文案）。
  it('删除 / 推送 / 发布 有提示', () => {
    for (const category of ['delete', 'push', 'publish']) {
      assert.ok(firstTimeNote(category), `${category} 应该有提示`);
    }
  });

  it('付款 / 对外发送 **不**在本次范围（已有审批卡片说清）', () => {
    assert.equal(firstTimeNote('pay'), null);
    assert.equal(firstTimeNote('external_send'), null);
  });

  it('未知类别不提示', () => {
    assert.equal(firstTimeNote('something_else'), null);
  });

  it('提示文案说清"不可逆在哪"，不是泛泛的警告', () => {
    assert.match(firstTimeNote('delete') ?? '', /撤销|恢复/);
    assert.match(firstTimeNote('push') ?? '', /远端|其他人/);
    assert.match(firstTimeNote('publish') ?? '', /外部|撤回/);
  });

  it('没有 localStorage 时每次都提示（宁可多说，不可漏说）', () => {
    // node 环境没有 localStorage，所以连续两次都应有提示
    assert.ok(firstTimeNote('delete'));
    assert.ok(firstTimeNote('delete'));
  });

  it('markNoteSeen / resetSeen 在无存储时不抛异常', () => {
    assert.doesNotThrow(() => markNoteSeen('delete'));
    assert.doesNotThrow(() => resetSeen('delete'));
  });
});
