import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Task, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

const FLIP_CHECK =
  'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'flip.flag\')){fs.writeFileSync(\'flip.flag\',\'1\');process.exit(0)}process.exit(9)"';

test('G1 验收自证：执行者自报通过，但系统复核失败则任务失败', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '改一行说明',
          subtasks: [
            {
              title: '实施：改说明',
              goal: '把说明改成 after',
              role: 'implementer',
              writeScope: ['note.txt'],
              acceptance: [
                { id: 'ac_flip', type: 'command', desc: '首次通过、复核失败', check: FLIP_CHECK },
              ],
              inputs: { mock: { files: [{ path: 'note.txt', content: 'after\n' }] } },
            },
            {
              title: '记录：验收日志',
              goal: '写一份验收日志',
              role: 'writer',
              writeScope: ['docs/'],
              inputs: { mock: { files: [{ path: 'docs/acceptance.md', content: '# log\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });

    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'awaiting_review' ? current : null;
    });
    const child = snapshot.tasks.find((task) => task.parentId === planned.root.id);
    assert.equal(child?.status, 'failed', '命令复核失败时子任务不得直接通过');

    const record = snapshot.acceptance.find(
      (item) => item.taskId === child?.id && item.criterionId === 'ac_flip',
    );
    assert.equal(record?.verdict, 'failed');
    assert.equal(record?.judgedBy, 'system');
    assert.ok(record?.evidenceIds.length, '失败结论必须带证据 id');

    const event = snapshot.events.find((item) => item.type === 'acceptance.verified');
    const payload = event?.payload as { reported?: Array<{ status?: string }> } | undefined;
    assert.equal(payload?.reported?.[0]?.status, 'passed', '员工自报仍保留在事件里供审计');
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('G2 逐条验收：缺理由/缺结论被拒绝，逐条决策后才可完成', async () => {
  const fixture = await makeRepo({ 'note.txt': 'hello\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '补一份说明',
          subtasks: [
            {
              title: '补一份备注',
              goal: '写一份备注',
              role: 'writer',
              writeScope: ['notes/'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认备注内容' }],
              inputs: { mock: { files: [{ path: 'notes/NOTE.md', content: '# note\n' }] } },
            },
            {
              title: '撰写说明',
              goal: '写一份说明',
              role: 'writer',
              writeScope: ['docs/'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认说明内容' }],
              inputs: { mock: { files: [{ path: 'docs/README.md', content: '# doc\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'awaiting_review' ? current : null;
    });

    const tree = snapshot.tasks.filter(
      (task) => task.id === planned.root.id || task.parentId === planned.root.id,
    );
    const pending = tree.flatMap((task) =>
      task.contract.acceptance_criteria
        .filter(
          (criterion) =>
            !snapshot.acceptance.some(
              (record) =>
                record.taskId === task.id &&
                record.criterionId === criterion.id &&
                record.verdict === 'passed',
            ),
        )
        .map((criterion) => ({ taskId: task.id, criterionId: criterion.id })),
    );
    assert.ok(pending.length > 0, '存在等待人工确认的验收项');

    await assert.rejects(
      daemon.call(`/api/tasks/${planned.root.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({ decisions: [] }),
      }),
      /409/,
      '没有结论时不能一键通过',
    );
    await assert.rejects(
      daemon.call(`/api/tasks/${planned.root.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({
          decisions: pending.map((item) => ({
            criterionId: `${item.taskId}:${item.criterionId}`,
            verdict: 'passed',
            note: '   ',
          })),
        }),
      }),
      /400/,
      '缺判断理由被拒绝',
    );
    await assert.rejects(
      daemon.call(`/api/tasks/${planned.root.id}/accept`, { method: 'POST' }),
      /404/,
      '批量盖章入口已移除',
    );

    const decided = await daemon.call<Task>(`/api/tasks/${planned.root.id}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({
        decisions: pending.map((item) => ({
          criterionId: `${item.taskId}:${item.criterionId}`,
          verdict: 'passed',
          note: `人工确认 ${item.criterionId} 符合目标`,
        })),
      }),
    });
    assert.equal(decided.status, 'done');

    const final = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
    for (const item of pending) {
      const record = final.acceptance.find(
        (entry) => entry.taskId === item.taskId && entry.criterionId === item.criterionId,
      );
      assert.equal(record?.verdict, 'passed');
      assert.equal(record?.judgedBy, 'human');
      assert.equal(record?.note, `人工确认 ${item.criterionId} 符合目标`);
      assert.ok(record?.evidenceIds.length, '人的判断也留证据');
    }
    const humanEvidence = final.evidence.filter((item) => item.producedBy === 'human');
    assert.ok(humanEvidence.length >= pending.length);

    const replay = await daemon.text(`/api/tasks/${planned.root.id}/replay?format=markdown`);
    assert.match(replay, /人工确认 ac_human 符合目标/);
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
