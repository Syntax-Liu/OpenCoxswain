import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AcceptanceCriterion } from '@opencoxswain/shared';
import { SystemVerification } from '../verification.js';

test('diff 复算做内容级比对：patch hash 不一致即失败', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-verify-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'qa@example.com');
  git('config', 'user.name', 'qa');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-qm', 'change');
  const patchHash = createHash('sha256').update(git('diff', base)).digest('hex');

  const verification = new SystemVerification({ timeoutMs: 5000 });
  const criteria: AcceptanceCriterion[] = [{ id: 'ac_diff', type: 'diff', desc: '改动一致' }];
  const artifacts = [
    {
      type: 'diff' as const,
      path: path.join(dir, 'patch.diff'),
      meta: { files: 1, additions: 1, deletions: 0, paths: ['a.txt'], patchHash },
    },
  ];

  const passed = await verification.verify({
    taskId: 'tsk_1',
    worktree: dir,
    criteria,
    artifacts,
    baseRef: base,
  });
  assert.equal(passed.records[0]?.verdict, 'passed');

  const tampered = await verification.verify({
    taskId: 'tsk_1',
    worktree: dir,
    criteria,
    artifacts: [{ ...artifacts[0]!, meta: { ...artifacts[0]!.meta, patchHash: 'deadbeef' } }],
    baseRef: base,
  });
  assert.equal(tampered.records[0]?.verdict, 'failed');
});

test('rubric 证据齐备自动通过，缺证据交人', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-verify-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path.join(dir, 'README.md'), '# 标题\n\n{{anchor: src/a.ts}}\n');
  const verification = new SystemVerification({ timeoutMs: 5000 });
  const criteria: AcceptanceCriterion[] = [
    {
      id: 'ac_anchor',
      type: 'rubric',
      desc: '来源可解析',
      evidence_required: ['anchor'],
    },
    {
      id: 'ac_human',
      type: 'rubric',
      desc: '需要人判断',
    },
  ];
  const result = await verification.verify({
    taskId: 'tsk_2',
    worktree: dir,
    criteria,
    artifacts: [
      { type: 'file', path: path.join(dir, 'README.md'), meta: { paths: ['README.md'] } },
    ],
    profile: 'document',
  });
  const byId = new Map(result.records.map((record) => [record.criterionId, record]));
  assert.equal(byId.get('ac_anchor')?.verdict, 'failed', '锚点目标不存在直接失败');
  assert.equal(byId.get('ac_human')?.verdict, 'unverified');
  assert.ok(result.evidence.some((item) => item.kind === 'provenance'));
  assert.ok(result.evidence.some((item) => item.kind === 'anchor'));

  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const resolved = await verification.verify({
    taskId: 'tsk_2',
    worktree: dir,
    criteria,
    artifacts: [
      { type: 'file', path: path.join(dir, 'README.md'), meta: { paths: ['README.md'] } },
    ],
    profile: 'document',
  });
  const resolvedById = new Map(resolved.records.map((record) => [record.criterionId, record]));
  assert.equal(resolvedById.get('ac_anchor')?.verdict, 'unverified', '单条锚点不足 3 条阈值');
});

test('document profile：锚点齐备时自动预验通过', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-verify-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'docs', 'a.md'), '# A\n');
  await writeFile(path.join(dir, 'docs', 'b.md'), '# B\n');
  await writeFile(path.join(dir, 'docs', 'c.md'), '# C\n');
  await writeFile(
    path.join(dir, 'README.md'),
    '# 报告\n\n{{anchor: docs/a.md}}\n{{anchor: docs/b.md}}\n{{anchor: docs/c.md}}\n',
  );
  const verification = new SystemVerification({ timeoutMs: 5000 });
  const result = await verification.verify({
    taskId: 'tsk_3',
    worktree: dir,
    criteria: [
      { id: 'ac_anchor', type: 'rubric', desc: '来源可解析', evidence_required: ['anchor'] },
    ],
    artifacts: [
      { type: 'file', path: path.join(dir, 'README.md'), meta: { paths: ['README.md'] } },
    ],
    profile: 'document',
  });
  assert.equal(result.records[0]?.verdict, 'passed');
  assert.equal(result.records[0]?.judgedBy, 'verifier');
});
