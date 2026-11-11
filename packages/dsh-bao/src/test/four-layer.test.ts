/**
 * 四层结构验收测试。
 *
 * 每个测试对应用户设想里的一条明确要求，注释里标了出处。
 * 用 node:test，断言尽量压在**可观察行为**上而不是内部实现。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeWriteScopes, scopesConflict } from '../executor/gate.js';
import { classifyBlock } from '../executor/runner.js';
import { judge } from '../assistant/judge.js';
import { deliver, stop } from '../inbox/queue.js';
import { normalizeRootPath } from '../domain.js';
import type { ExecutorRow } from '../domain.js';

// ---------------------------------------------------------------------------
// 写域互斥：方案 §7.2 / L4（"不冲突就并行，冲突就排队"）
// ---------------------------------------------------------------------------

describe('写域互斥（方案 §7.2 / L4）', () => {
  it('前缀相交视为冲突', () => {
    assert.equal(scopesConflict(['src'], ['src/auth']), true);
    assert.equal(scopesConflict(['src/auth'], ['src']), true);
    assert.equal(scopesConflict(['src/auth'], ['src/auth']), true);
  });

  it('同一父目录下的兄弟路径不冲突', () => {
    assert.equal(scopesConflict(['src/auth'], ['src/export']), false);
  });

  it('路径边界按 "/" 判断，不能把 src/a 误判成 src/ab', () => {
    assert.equal(scopesConflict(['src/a'], ['src/ab']), false);
    assert.equal(scopesConflict(['src/a'], ['src/a/b']), true);
  });

  it('任一方未声明写域 → 冲突（保守串行）', () => {
    assert.equal(scopesConflict([], ['src']), true);
    assert.equal(scopesConflict(['src'], []), true);
    assert.equal(scopesConflict([], []), true);
  });

  it('归一化处理反斜杠、逗号、尾斜杠与重复项', () => {
    assert.deepEqual(normalizeWriteScopes('src\\auth/ , src/export'), [
      'src/auth',
      'src/export',
    ]);
    assert.deepEqual(normalizeWriteScopes(['a/', 'a', 'b']), ['a', 'b']);
    assert.deepEqual(normalizeWriteScopes(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// 冲突判定：方案 §4（"有冲突按新的来，无冲突并行"）
// ---------------------------------------------------------------------------

function fakeExecutor(id: string, writeScope: string, status: ExecutorRow['status'] = 'running'): ExecutorRow {
  return {
    id,
    projectId: 'prj_1',
    sessionId: `s_${id}`,
    label: id,
    goal: 'g',
    status,
    resumable: 0,
    writeScope,
    summary: null,
    blockedReason: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    endedAt: null,
  };
}

describe('冲突判定（方案 §4）', () => {
  it('没有在跑的 D → 判定为新增', () => {
    const r = judge({ writeScopes: ['src'], active: [] });
    assert.equal(r.judged, 'new');
  });

  it('写域不相交 → 判定为可并行', () => {
    const r = judge({ writeScopes: ['src/export'], active: [fakeExecutor('d1', 'src/auth')] });
    assert.equal(r.judged, 'parallel');
    assert.match(r.reason, /不相交，可并行/);
  });

  it('写域相交 → 判定为冲突，并指出和谁冲突', () => {
    const r = judge({ writeScopes: ['src/auth/login'], active: [fakeExecutor('d1', 'src/auth')] });
    assert.equal(r.judged, 'conflict');
    assert.equal(r.conflictWith, 'd1');
  });

  it('已终态的 D 不参与冲突判定', () => {
    const r = judge({ writeScopes: ['src/auth'], active: [fakeExecutor('d1', 'src/auth', 'done')] });
    assert.equal(r.judged, 'new');
  });
});

// ---------------------------------------------------------------------------
// 连发不打断：方案 §4 + P0-T4
// ---------------------------------------------------------------------------

describe('连发不打断（方案 §4 / P0-T4）', () => {
  function fakeAgent() {
    const calls: string[] = [];
    const agent = {
      id: 'c1',
      session: { id: 'c1' },
      followup: () => calls.push('followup'),
      steer: () => calls.push('steer'),
      cancel: () => calls.push('cancel'),
    };
    return { agent, calls };
  }

  it('默认走 followup，绝不 steer / cancel', () => {
    const { agent, calls } = fakeAgent();
    const result = deliver({ agent, text: '第一句' });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'followup');
    assert.deepEqual(calls, ['followup']);
  });

  it('只有 urgent 才走 steer', () => {
    const { agent, calls } = fakeAgent();
    const result = deliver({ agent, text: '改一下', urgent: true });
    assert.equal(result.mode, 'steer');
    assert.deepEqual(calls, ['steer']);
  });

  it('steer 不可用时降级为 followup，而不是退回打断', () => {
    const calls: string[] = [];
    const agent = {
      id: 'c1',
      followup: () => calls.push('followup'),
      cancel: () => calls.push('cancel'),
    };
    const result = deliver({ agent, text: '改一下', urgent: true });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'followup');
    assert.deepEqual(calls, ['followup']);
  });

  it('连续多条消息都排成各自的下一轮，互不打断', () => {
    const { agent, calls } = fakeAgent();
    deliver({ agent, text: '一' });
    deliver({ agent, text: '二' });
    deliver({ agent, text: '三' });
    assert.deepEqual(calls, ['followup', 'followup', 'followup']);
  });

  it('只有用户点停止才 cancel，且保留排队消息', () => {
    const calls: Array<{ name: string; options?: unknown }> = [];
    const agent = {
      id: 'c1',
      cancel: (_cause: unknown, options?: unknown) => calls.push({ name: 'cancel', options }),
    };
    const result = stop(agent);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.options, { keepInbox: true });
  });
});

// ---------------------------------------------------------------------------
// 卡点分类：方案 §6 P4-T1（C 主动推进的前提）
// ---------------------------------------------------------------------------

describe('卡点三分类（方案 §6 P4-T1）', () => {
  it('环境问题单独归类', () => {
    assert.equal(classifyBlock('Error: EPERM permission denied').kind, 'environment');
    assert.equal(classifyBlock('command not found: pnpm').kind, 'environment');
  });

  it('改错路径 / 测试失败属于可自行重试', () => {
    assert.equal(classifyBlock('TypeError: cannot read property').kind, 'self-recoverable');
    assert.equal(classifyBlock('assertion failed: expected 1 received 2').kind, 'self-recoverable');
  });

  it('无法判断时保守地归为需用户决定', () => {
    assert.equal(classifyBlock('需求本身存在歧义').kind, 'needs-user');
  });
});

// ---------------------------------------------------------------------------
// 路径归一化：多项目不串台的前提
// ---------------------------------------------------------------------------

describe('项目路径归一化', () => {
  it('反斜杠/尾斜杠/大小写统一', () => {
    assert.equal(normalizeRootPath('D:\\Work\\App\\'), 'd:/work/app');
    assert.equal(normalizeRootPath('d:/work/app'), 'd:/work/app');
  });
});
