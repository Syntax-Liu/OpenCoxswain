import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { GateQuality, Task, WorkbenchSnapshot } from '@opencoxswain/shared';
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
      return root?.status === 'failed' ? current : null;
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
    const rootTask = tree.find((task) => task.id === planned.root.id)!;
    const children = tree.filter((task) => task.parentId === planned.root.id);
    const pendingFor = (task: Task) =>
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
        .map((criterion) => ({ taskId: task.id, criterionId: criterion.id }));
    const pending = tree.flatMap(pendingFor);
    const rootPending = pendingFor(rootTask);
    assert.ok(pending.length > 0, '存在等待人工确认的验收项');
    const target = children.find((child) => pendingFor(child).length > 0)!;
    const targetPending = pendingFor(target);

    await assert.rejects(
      daemon.call(`/api/tasks/${target.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({ decisions: [] }),
      }),
      /409/,
      '没有结论时不能一键通过',
    );
    await assert.rejects(
      daemon.call(`/api/tasks/${target.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({
          decisions: targetPending.map((item) => ({
            criterionId: item.criterionId,
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

    // 子任务先单独验收；根任务不会因此放行。
    for (const child of children) {
      const childPending = pendingFor(child);
      if (childPending.length === 0) continue;
      await daemon.call(`/api/tasks/${child.id}/viewed`, { method: 'POST' });
      const decidedChild = await daemon.call<Task>(`/api/tasks/${child.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({
          decisions: childPending.map((item) => ({
            criterionId: item.criterionId,
            verdict: 'passed',
            note: `人工确认 ${item.criterionId} 符合目标`,
          })),
        }),
      });
      assert.equal(decidedChild.status, 'done');
      assert.ok(decidedChild.firstViewedAt, '打开验收单写入 first_viewed_at');
    }
    const midway = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
    assert.equal(
      midway.tasks.find((task) => task.id === planned.root.id)?.status,
      'awaiting_review',
      '子任务验收不会顺带放行根任务',
    );

    const decided = await daemon.call<Task>(`/api/tasks/${planned.root.id}/acceptance`, {
      method: 'POST',
      body: JSON.stringify({
        decisions: rootPending.map((item) => ({
          criterionId: item.criterionId,
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

    const brief = final.briefs.find((item) => item.taskId === planned.root.id);
    assert.ok(brief, '根任务有决策说明');
    for (const field of ['changed', 'why', 'verified', 'risks'] as const) {
      assert.ok(brief![field].trim(), `决策说明包含「${field}」`);
    }
    assert.ok(final.review.samples >= 1, '反馈延迟有样本');
    assert.ok(final.review.viewLagP50 !== null, '首次查看延迟可算 p50');
    assert.ok(final.review.decideLagP50 !== null, '决策延迟可算 p50');

    const replay = await daemon.text(`/api/tasks/${planned.root.id}/replay?format=markdown`);
    assert.match(replay, /人工确认 ac_human 符合目标/);
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('G3 门禁质量：自动判定、系统拦下、人工收口分开记账', async () => {
  const passing = await makeRepo({ 'note.txt': 'before\n' });
  const blocked = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(passing.home);
  try {
    const auto = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: passing.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${auto.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '补一份说明',
          subtasks: [
            {
              title: '实施：改说明',
              goal: '把说明改成 after',
              role: 'implementer',
              writeScope: ['note.txt'],
              acceptance: [
                {
                  id: 'ac_auto',
                  type: 'command',
                  desc: '命令自检通过',
                  check: 'node -e "process.exit(0)"',
                },
              ],
              inputs: { mock: { files: [{ path: 'note.txt', content: 'after\n' }] } },
            },
            {
              title: '记录：说明变更',
              goal: '写一份说明变更记录',
              role: 'writer',
              writeScope: ['docs/'],
              acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认记录内容' }],
              inputs: { mock: { files: [{ path: 'docs/change.md', content: '# change\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>(`/api/bootstrap?projectId=${auto.id}`);
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'awaiting_review' ? current : null;
    });

    const children = snapshot.tasks.filter((task) => task.parentId === planned.root.id);
    const rootTask = snapshot.tasks.find((task) => task.id === planned.root.id)!;
    const pendingFor = (task: Task) =>
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
        .map((criterion) => criterion.id);
    for (const task of [...children, rootTask]) {
      const pending = pendingFor(task);
      if (pending.length === 0) continue;
      await daemon.call(`/api/tasks/${task.id}/acceptance`, {
        method: 'POST',
        body: JSON.stringify({
          decisions: pending.map((criterionId) => ({
            criterionId,
            verdict: 'passed',
            note: '人工确认符合目标',
          })),
        }),
      });
    }

    const autoQuality = await daemon.call<GateQuality>(`/api/gate-quality?projectId=${auto.id}`);
    assert.ok(autoQuality.systemPassed >= 1, '系统自动判定通过至少一项');
    assert.equal(autoQuality.systemFailed, 0, '本项目没有被系统拦下的项');
    assert.ok(autoQuality.unverified >= 1, '未能判定的项记为待人工');
    assert.ok(autoQuality.humanJudged >= 1, '人工收口被计数');
    assert.equal(autoQuality.humanPassed, autoQuality.humanJudged);
    assert.equal(autoQuality.autoPassRate, 1);
    assert.equal(autoQuality.humanPassRate, 1);

    const repeat = await daemon.call<GateQuality>(`/api/gate-quality?projectId=${auto.id}`);
    assert.deepEqual(repeat, autoQuality, '查询只读，不改变门禁统计');

    const failing = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: blocked.repo }),
    });
    const blockedPlan = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${failing.id}/plan`,
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
              title: '记录：变更说明',
              goal: '写一份变更说明',
              role: 'writer',
              writeScope: ['docs/'],
              acceptance: [{ id: 'ac_note', type: 'human', desc: '用户确认变更说明' }],
              inputs: { mock: { files: [{ path: 'docs/change.md', content: '# change\n' }] } },
            },
          ],
        }),
      },
    );
    await daemon.call(`/api/tasks/${blockedPlan.root.id}/approve`, { method: 'POST' });
    await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>(
        `/api/bootstrap?projectId=${failing.id}`,
      );
      const root = current.tasks.find((task) => task.id === blockedPlan.root.id);
      return root?.status === 'failed' ? true : null;
    });

    const blockedQuality = await daemon.call<GateQuality>(
      `/api/gate-quality?projectId=${failing.id}`,
    );
    assert.ok(blockedQuality.systemJudged >= 1, '系统对命令复核作了判定');
    assert.equal(blockedQuality.systemPassed, 0);
    assert.equal(blockedQuality.systemFailed, 1, '复核失败被记为系统拦下');
    assert.equal(blockedQuality.humanJudged, 0, '还没人收口');
    assert.equal(blockedQuality.humanPassed, 0);
    assert.equal(blockedQuality.humanFailed, 0);
    assert.equal(blockedQuality.autoPassRate, 0);
    assert.equal(blockedQuality.humanPassRate, null, '没有人工样本时不编造通过率');
    assert.equal(
      (await daemon.call<GateQuality>(`/api/gate-quality?projectId=${auto.id}`)).systemFailed,
      0,
      '按项目过滤不混入其他项目',
    );
    const all = await daemon.call<GateQuality>('/api/gate-quality');
    assert.equal(all.systemFailed, 1);
    assert.equal(all.humanJudged, autoQuality.humanJudged, '不带项目时汇总一致');
  } finally {
    await daemon.app.close();
    await rm(passing.temp, { recursive: true, force: true }).catch(() => undefined);
    await rm(blocked.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
