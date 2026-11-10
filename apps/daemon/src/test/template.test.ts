import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type {
  DeliveryPlan,
  Project,
  Task,
  TaskTemplate,
  WorkbenchSnapshot,
} from '@opencoxswain/shared';
import { InMemoryTemplateRegistry } from '../plugins/templates/registry.js';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

const FLIP_CHECK =
  'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'flip.flag\')){fs.writeFileSync(\'flip.flag\',\'1\');process.exit(0)}process.exit(9)"';

const BASE: Omit<TaskTemplate, 'pluginId'> = {
  id: 'template.test',
  name: '测试模板',
  summary: '仅用于测试',
  goal: '完成一个测试目标',
  role: 'implementer',
  deliverables: [{ type: 'diff' }],
  acceptance: [{ id: 'ac_human', type: 'human', desc: '用户确认' }],
  writeScope: ['**'],
  allowAutoMerge: false,
  deliverableProfile: 'code',
  acceptancePolicy: 'unverified_only',
};

test('任务模板注册表：id 唯一、禁止 auto 验收、只读角色不能写', () => {
  const registry = new InMemoryTemplateRegistry();
  const dispose = registry.register(BASE, 'template.a');
  assert.equal(registry.get('template.test')?.pluginId, 'template.a');
  assert.throws(() => registry.register(BASE, 'template.b'), /已被插件 template\.a 占用/);
  assert.throws(
    () =>
      registry.register(
        { ...BASE, id: 'template.auto', acceptancePolicy: 'auto' as never },
        'template.c',
      ),
    /unverified_only/,
  );
  assert.throws(
    () => registry.register({ ...BASE, id: 'template.ro', role: 'researcher' }, 'template.d'),
    /只读角色/,
  );
  dispose();
  assert.equal(registry.get('template.test'), undefined);
});

test('任务模板：应用后仍待确认，权限与验收可见，自动合并开关生效', async () => {
  const fixture = await makeRepo({ 'README.md': 'origin\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const templates = await daemon.call<TaskTemplate[]>('/api/templates');
    assert.equal(templates.length, 5);
    assert.deepEqual(
      templates.map((template) => template.id).sort(),
      ['bugfix', 'docs', 'feature', 'refactor', 'research'],
    );
    for (const template of templates) {
      assert.equal(template.acceptancePolicy, 'unverified_only', `${template.id} 不能自动放行`);
      assert.equal(template.pluginId, 'template.registry');
    }
    const docs = templates.find((template) => template.id === 'docs');
    assert.ok(docs);
    assert.equal(docs.allowAutoMerge, true);

    const project = await daemon.call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });

    // 不传 goal：模板自带目标描述；也不传 subtasks：模板落成主执行 + 校验。
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      { method: 'POST', body: JSON.stringify({ templateId: 'docs' }) },
    );
    assert.equal(planned.root.status, 'awaiting_approval', '套模板仍需用户确认开工');
    assert.equal(planned.root.goal, docs.goal);
    assert.equal(planned.root.contract.template_id, 'docs');
    assert.equal(planned.root.contract.allow_auto_merge, true);
    assert.equal(planned.children.length, 2);
    const implementer = planned.children.find(
      (child) => child.contract.assignee?.role === 'implementer',
    );
    assert.ok(implementer);
    assert.deepEqual(implementer.contract.write_scope, ['**/*.md', 'docs/**']);
    assert.deepEqual(
      implementer.contract.acceptance_criteria.map((item) => item.type),
      ['diff', 'human'],
    );
    assert.equal(implementer.contract.deliverable_profile, 'document');

    const snapshot = await daemon.call<WorkbenchSnapshot>(
      `/api/bootstrap?projectId=${project.id}`,
    );
    assert.equal(snapshot.project?.allowNetwork, true, '模板不改变项目联网授权');
    assert.equal(snapshot.project?.allowExternalSend, false, '模板不改变项目外发授权');
    assert.equal(snapshot.templates.length, 5);

    const docsDelivery = await daemon.call<DeliveryPlan>(
      `/api/tasks/${planned.root.id}/delivery`,
    );
    assert.ok(
      !docsDelivery.blockedReasons.includes('该任务模板未允许一键合并，请手动合并'),
      '允许合并的模板不应被模板规则拦下',
    );

    // 切换为不允许自动合并的模板，计划会替换上一张草稿单。
    const bugfix = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({ templateId: 'bugfix', goal: '修复登录按钮无响应' }),
      },
    );
    assert.equal(bugfix.root.contract.template_id, 'bugfix');
    assert.equal(bugfix.root.contract.allow_auto_merge, false);
    const bugfixDelivery = await daemon.call<DeliveryPlan>(
      `/api/tasks/${bugfix.root.id}/delivery`,
    );
    assert.ok(
      bugfixDelivery.blockedReasons.includes('该任务模板未允许一键合并，请手动合并'),
      '模板不允许时必须阻止一键合并',
    );

    const failed = await fetch(
      `http://127.0.0.1:${daemon.app.port}/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: 'no-such-template', goal: 'x' }),
      },
    );
    assert.equal(failed.status, 400);
    assert.match(await failed.text(), /任务模板不存在/);
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('模板任务：员工自报通过但系统重跑 command 失败时任务失败，模板策略不放行', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'bugfix',
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
    assert.equal(planned.root.contract.template_id, 'bugfix');
    assert.equal(planned.root.contract.acceptance_policy, 'unverified_only');

    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>(
        `/api/bootstrap?projectId=${project.id}`,
      );
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'failed' ? current : null;
    });

    const implementer = snapshot.tasks.find(
      (task) => task.parentId === planned.root.id && task.contract.assignee?.role === 'implementer',
    );
    assert.equal(implementer?.status, 'failed', '系统复核失败时不得因模板策略放过');
    const record = snapshot.acceptance.find(
      (item) => item.taskId === implementer?.id && item.criterionId === 'ac_flip',
    );
    assert.equal(record?.verdict, 'failed');
    assert.equal(record?.judgedBy, 'system');

    // 员工自报仍留在事件里供审计，但没有参与判定。
    const event = snapshot.events.find(
      (item) => item.type === 'acceptance.verified' && item.taskId === implementer?.id,
    );
    const payload = event?.payload as { reported?: Array<{ status?: string }> } | undefined;
    assert.equal(payload?.reported?.[0]?.status, 'passed');
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('模板任务：系统复核通过但人工项未决时按策略落到 awaiting_review', async () => {
  const fixture = await makeRepo({ 'note.txt': 'before\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const project = await daemon.call<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          templateId: 'bugfix',
          goal: '改一行说明',
          subtasks: [
            {
              title: '实施：改说明',
              goal: '把说明改成 after',
              role: 'implementer',
              writeScope: ['note.txt'],
              acceptance: [
                { id: 'ac_diff', type: 'diff', desc: '改动与修复目标一致' },
                { id: 'ac_human', type: 'human', desc: '用户确认缺陷已修复' },
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
    assert.equal(planned.root.contract.template_id, 'bugfix');
    assert.equal(planned.root.contract.acceptance_policy, 'unverified_only');

    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>(
        `/api/bootstrap?projectId=${project.id}`,
      );
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root?.status === 'awaiting_review' ? current : null;
    });

    const implementer = snapshot.tasks.find(
      (task) => task.parentId === planned.root.id && task.contract.assignee?.role === 'implementer',
    );
    assert.equal(implementer?.status, 'awaiting_review', '人工项未决时不能直接 done');
    const diff = snapshot.acceptance.find(
      (item) => item.taskId === implementer?.id && item.criterionId === 'ac_diff',
    );
    assert.equal(diff?.verdict, 'passed', 'diff 由系统复算通过');
    assert.equal(diff?.judgedBy, 'system');
    const human = snapshot.acceptance.find(
      (item) => item.taskId === implementer?.id && item.criterionId === 'ac_human',
    );
    assert.equal(human?.verdict, 'unverified', '人工项保留给用户判定');
    assert.equal(human?.judgedBy, 'system');
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
