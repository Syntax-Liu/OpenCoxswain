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
import { makeDaemon, makeRepo } from './helpers.js';

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
