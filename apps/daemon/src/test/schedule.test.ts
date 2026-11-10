import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { Project, Schedule, ScheduleRun, WorkbenchSnapshot } from '@opencoxswain/shared';
import { makeDaemon, makeRepo } from './helpers.js';

test('定时任务：立即生成只落待审批任务单，并按间隔推进下一次', async () => {
  const fixture = await makeRepo({ 'README.md': 'origin\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });

    const created = await daemon.call<Schedule>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        title: '每日巡检',
        goal: '检查仓库当前状态',
        templateId: 'bugfix',
        intervalMinutes: 60,
      }),
    });
    assert.equal(created.enabled, true);
    assert.equal(created.templateId, 'bugfix');
    assert.equal(created.intervalMinutes, 60);
    assert.equal(created.lastRunAt, null);
    assert.ok(created.nextRunAt > created.createdAt, '默认从现在开始计时');

    const listed = await daemon.call<{ schedules: Schedule[] }>(
      `/api/schedules?projectId=${project.id}`,
    );
    assert.equal(listed.schedules.length, 1);
    assert.equal(listed.schedules[0]?.id, created.id);

    const run = await daemon.call<ScheduleRun>(`/api/schedules/${created.id}/run`, {
      method: 'POST',
    });
    assert.equal(run.outcome, 'created');
    assert.ok(run.taskId);
    assert.equal(run.schedule.lastTaskId, run.taskId);
    assert.equal(
      run.schedule.nextRunAt,
      (run.schedule.lastRunAt ?? 0) + 60 * 60_000,
      '触发后按间隔推进下一次',
    );

    const snapshot = await daemon.call<WorkbenchSnapshot>(
      `/api/bootstrap?projectId=${project.id}`,
    );
    const root = snapshot.tasks.find((task) => task.id === run.taskId);
    assert.ok(root);
    assert.equal(root.status, 'awaiting_approval', '定时任务只准备任务单，不自动开工');
    assert.equal(root.contract.template_id, 'bugfix');
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('定时任务：有未完成任务时跳过，停用后拒绝触发，删除后不再列出', async () => {
  const fixture = await makeRepo({ 'README.md': 'origin\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });

    await assert.rejects(
      () =>
        daemon.call<Schedule>('/api/schedules', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            title: '非法间隔',
            goal: '不该被创建',
            intervalMinutes: 0,
          }),
        }),
      /间隔/,
    );
    await assert.rejects(
      () =>
        daemon.call<Schedule>('/api/schedules', {
          method: 'POST',
          body: JSON.stringify({
            projectId: project.id,
            title: '未知模板',
            goal: '不该被创建',
            templateId: 'template.missing',
            intervalMinutes: 30,
          }),
        }),
      /未知任务模板/,
    );

    const created = await daemon.call<Schedule>('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({
        projectId: project.id,
        title: '每半小时备份检查',
        goal: '检查备份目录',
        intervalMinutes: 30,
      }),
    });

    const first = await daemon.call<ScheduleRun>(`/api/schedules/${created.id}/run`, {
      method: 'POST',
    });
    assert.equal(first.outcome, 'created');

    const before = await daemon.call<WorkbenchSnapshot>(
      `/api/bootstrap?projectId=${project.id}`,
    );
    const second = await daemon.call<ScheduleRun>(`/api/schedules/${created.id}/run`, {
      method: 'POST',
    });
    assert.equal(second.outcome, 'skipped', '有未完成任务时跳过，不抢占也不排队');
    assert.equal(second.taskId, null);
    assert.match(second.reason ?? '', /未完成/);
    assert.equal(second.schedule.lastTaskId, first.taskId, '跳过不覆盖上次生成的任务单');

    const after = await daemon.call<WorkbenchSnapshot>(
      `/api/bootstrap?projectId=${project.id}`,
    );
    assert.equal(after.tasks.length, before.tasks.length, '跳过不产生新任务');

    const disabled = await daemon.call<Schedule>(
      `/api/schedules/${created.id}/enabled`,
      { method: 'POST', body: JSON.stringify({ enabled: false }) },
    );
    assert.equal(disabled.enabled, false);
    await assert.rejects(
      () => daemon.call(`/api/schedules/${created.id}/run`, { method: 'POST' }),
      /409/,
    );

    const enabled = await daemon.call<Schedule>(
      `/api/schedules/${created.id}/enabled`,
      { method: 'POST', body: JSON.stringify({ enabled: true }) },
    );
    assert.equal(enabled.enabled, true);

    await daemon.call<{ ok: boolean }>(`/api/schedules/${created.id}`, { method: 'DELETE' });
    const listed = await daemon.call<{ schedules: Schedule[] }>(
      `/api/schedules?projectId=${project.id}`,
    );
    assert.equal(listed.schedules.length, 0);
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
