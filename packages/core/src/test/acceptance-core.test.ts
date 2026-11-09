import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDelegation, PLAN_NOT_DECOMPOSED } from '../delegation.js';
import {
  issueMandate,
  mandateCoversWriteScope,
  mandateViolation,
  scopeCovers,
} from '../mandate.js';
import { extractAnchors, verifyProvenance } from '../provenance.js';
import type { Task, TaskContract } from '@opencoxswain/shared';

function contract(patch: Partial<TaskContract> = {}): TaskContract {
  return {
    task_id: 'tsk_child',
    parent_id: 'tsk_root',
    project_id: 'prj_1',
    title: '子任务',
    goal: '实现一个可执行的子任务',
    deliverables: [{ type: 'diff' }],
    acceptance_criteria: [
      { id: 'ac1', type: 'rubric', desc: '检查', evidence_required: ['anchor'] },
    ],
    dependencies: [],
    write_scope: ['docs/'],
    assignee: { role: 'writer', runtime: 'mock', model: 'mock' },
    budget: { usd: 1 },
    review: { required: true },
    ...patch,
  };
}

function taskWith(patch: Partial<TaskContract> = {}): Task {
  const value = contract(patch);
  return {
    id: value.task_id,
    projectId: value.project_id,
    parentId: value.parent_id,
    title: value.title,
    goal: value.goal,
    status: 'queued',
    assigneeId: null,
    contract: value,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('非平凡任务未被拆分 → PLAN_NOT_DECOMPOSED', () => {
  const root = contract({
    task_id: 'tsk_root',
    parent_id: null,
    goal: '实现登录、审计并补齐文档，同时升级依赖',
    acceptance_criteria: [],
  });
  const errors = validateDelegation(root, []);
  assert.ok(errors.some((error) => error.includes(PLAN_NOT_DECOMPOSED)));
});

test('写域与角色覆盖通过委派校验', () => {
  const root = contract({
    task_id: 'tsk_root',
    parent_id: null,
    goal: '实现登录、审计并补齐文档，同时升级依赖',
    acceptance_criteria: [],
  });
  const errors = validateDelegation(root, [
    contract(),
    contract({
      task_id: 'tsk_verify',
      assignee: { role: 'verifier', runtime: 'mock', model: 'mock' },
      write_scope: [],
    }),
  ]);
  assert.deepEqual(errors, []);
});

test('anchor 提取去重并忽略页内锚点', () => {
  const content = [
    '# 报告',
    '结论一 {{anchor: notes/a.md#L1-L3}}',
    '结论二 [来源](https://example.com/report)',
    '来源：docs/b.md, #local',
    '来源：docs/b.md',
  ].join('\n');
  assert.deepEqual(extractAnchors(content).sort(), [
    'docs/b.md',
    'https://example.com/report',
    'notes/a.md#L1-L3',
  ]);
});

test('来源校验：缺失→unverified，不可解析→failed，齐备→passed', () => {
  assert.equal(verifyProvenance({ content: '没有出处' }).verdict, 'unverified');
  assert.equal(
    verifyProvenance({
      content: '{{anchor: a.md}} {{anchor: b.md}} {{anchor: c.md}}',
      unresolved: ['b.md'],
      profile: 'document',
    }).verdict,
    'failed',
  );
  assert.equal(
    verifyProvenance({
      content: '{{anchor: a.md}} {{anchor: b.md}} {{anchor: c.md}}',
      profile: 'document',
    }).verdict,
    'passed',
  );
});

test('Mandate：工具别名、写域与过期', () => {
  const task = taskWith();
  const mandate = issueMandate(task, {
    id: 'mnd_1',
    issuedBy: 'approval',
    allowedTools: ['read', 'write'],
    ttlMs: 1000,
    now: 1000,
  });
  assert.deepEqual(mandate.scope.writePaths, ['docs/']);
  assert.equal(mandateViolation(mandate, 'bash', {}, 1000), '工具 bash 不在授权范围');
  assert.equal(
    mandateViolation(mandate, 'file_write', { path: 'src/secret.ts' }, 1000),
    '写入路径 src/secret.ts 超出授权写域',
  );
  assert.equal(mandateViolation(mandate, 'file_write', { path: 'docs/a.md' }, 1000), null);
  assert.equal(mandateViolation(mandate, 'write', { path: 'docs/a.md' }, 2000), '任务授权已过期');
  assert.deepEqual(mandateCoversWriteScope(mandate, ['src/']), ['写域 src/ 超出任务授权']);
  assert.equal(scopeCovers(['**'], 'anything/here.ts'), true);
});
