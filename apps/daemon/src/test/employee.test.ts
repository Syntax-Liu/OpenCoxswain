import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { EmployeeDefinition, Task, WorkbenchSnapshot } from '@opencoxswain/shared';
import { InMemoryEmployeeRegistry } from '../plugins/employees/registry.js';
import { makeDaemon, makeRepo, waitFor } from './helpers.js';

const BASE: Omit<EmployeeDefinition, 'pluginId'> = {
  id: 'employee.test',
  role: 'writer',
  name: '测试员工',
  description: '仅用于测试',
  version: '0.0.0',
  skills: ['写作'],
  tools: ['read', 'write'],
  capabilities: ['fs.read', 'fs.write'],
  readOnly: false,
  acceptanceDefaults: [{ id: 'ac_human', type: 'human', desc: '用户确认' }],
  outputSchema: 'worker-result.v1',
};

test('员工注册表：角色唯一、五件套校验、可注销后重装', () => {
  const registry = new InMemoryEmployeeRegistry();
  const dispose = registry.register(BASE, 'employee.a');
  assert.equal(registry.get('writer')?.pluginId, 'employee.a');
  assert.throws(() => registry.register(BASE, 'employee.b'), /已被员工插件 employee\.a 占用/);
  assert.throws(
    () => registry.register({ ...BASE, id: 'x', role: 'researcher', readOnly: true }, 'employee.c'),
    /只读员工不能声明 fs\.write/,
  );
  assert.throws(
    () => registry.register({ ...BASE, id: 'x', acceptanceDefaults: [] }, 'employee.d'),
    /acceptanceDefaults 不能为空/,
  );
  dispose();
  assert.equal(registry.get('writer'), undefined);
  assert.doesNotThrow(() => registry.register(BASE, 'employee.b'));
});

test('员工插件包：内置四角色可安装，Planner 与调度器都消费员工包', async () => {
  const fixture = await makeRepo({ 'note.txt': 'hello\n' });
  const daemon = await makeDaemon(fixture.home);
  try {
    const employees = await daemon.call<EmployeeDefinition[]>('/api/employees');
    assert.deepEqual(
      employees.map((employee) => employee.role).sort(),
      ['implementer', 'researcher', 'verifier', 'writer'],
    );
    for (const employee of employees) {
      assert.ok(employee.skills.length > 0, `${employee.role} 缺少技能`);
      assert.ok(employee.tools.length > 0, `${employee.role} 缺少工具`);
      assert.ok(employee.capabilities.length > 0, `${employee.role} 缺少能力`);
      assert.ok(employee.acceptanceDefaults.length > 0, `${employee.role} 缺少默认验收`);
      assert.match(employee.pluginId, /^employee\./);
    }
    assert.equal(employees.find((employee) => employee.role === 'verifier')?.readOnly, true);

    const project = await daemon.call<{ id: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path: fixture.repo }),
    });
    const planned = await daemon.call<{ root: Task; children: Task[] }>(
      `/api/projects/${project.id}/plan`,
      {
        method: 'POST',
        body: JSON.stringify({
          goal: '整理说明文档',
          subtasks: [
            {
              title: '撰写说明',
              goal: '写一份说明',
              role: 'writer',
              writeScope: ['docs/'],
              inputs: { mock: { files: [{ path: 'docs/README.md', content: '# doc\n' }] } },
            },
            {
              title: '校验说明',
              goal: '检查说明',
              role: 'verifier',
              dependsOn: [0],
            },
          ],
        }),
      },
    );

    const writer = planned.children.find((task) => task.contract.assignee?.role === 'writer');
    const verifier = planned.children.find((task) => task.contract.assignee?.role === 'verifier');
    assert.deepEqual(
      writer?.contract.acceptance_criteria.map((criterion) => criterion.id),
      ['ac_anchors'],
      '未显式提供验收时使用撰写员插件包的默认验收',
    );
    assert.equal(writer?.contract.deliverable_profile, 'document');
    assert.deepEqual(
      verifier?.contract.acceptance_criteria.map((criterion) => criterion.id),
      ['ac_review'],
      '校验员默认验收来自员工插件包',
    );
    assert.deepEqual(verifier?.contract.write_scope, [], '只读属性来自员工插件包');
    assert.equal(writer?.contract.write_scope?.[0], 'docs/');

    await daemon.call(`/api/tasks/${planned.root.id}/approve`, { method: 'POST' });
    const snapshot = await waitFor(async () => {
      const current = await daemon.call<WorkbenchSnapshot>('/api/bootstrap');
      const root = current.tasks.find((task) => task.id === planned.root.id);
      return root && (root.status === 'awaiting_review' || root.status === 'failed')
        ? current
        : null;
    });
    const root = snapshot.tasks.find((task) => task.id === planned.root.id);
    assert.equal(root?.status, 'awaiting_review');

    const spawned = snapshot.events.filter((event) => event.type === 'worker.spawned');
    assert.equal(spawned.length, 2);
    for (const event of spawned) {
      const payload = event.payload as { employee?: string; employeePlugin?: string };
      assert.ok(payload.employee, '派单事件记录员工 id');
      assert.match(payload.employeePlugin ?? '', /^employee\./);
    }
  } finally {
    await daemon.app.close();
    await rm(fixture.temp, { recursive: true, force: true }).catch(() => undefined);
  }
});
