import type { TemplateRegistry } from '@opencoxswain/plugin-api';
import {
  ACCEPTANCE_TYPES,
  DELIVERABLE_PROFILES,
  DELIVERABLE_TYPES,
  ROLE_NAMES,
  type TaskTemplate,
} from '@opencoxswain/shared';

/** 任务模板注册表：只负责登记与查询，模板本身由插件提供。 */
export class InMemoryTemplateRegistry implements TemplateRegistry {
  private readonly byId = new Map<string, TaskTemplate>();

  register(template: Omit<TaskTemplate, 'pluginId'>, pluginId: string): () => void {
    validate(template, pluginId);
    const existing = this.byId.get(template.id);
    if (existing) {
      throw new Error(
        `任务模板 ${template.id} 已被插件 ${existing.pluginId} 占用，${pluginId} 不能重复注册`,
      );
    }
    this.byId.set(template.id, { ...template, pluginId });
    return () => {
      if (this.byId.get(template.id)?.pluginId === pluginId) {
        this.byId.delete(template.id);
      }
    };
  }

  get(id: string): TaskTemplate | undefined {
    return this.byId.get(id);
  }

  list(): TaskTemplate[] {
    return [...this.byId.values()];
  }
}

function validate(template: Omit<TaskTemplate, 'pluginId'>, pluginId: string): void {
  const fail = (message: string): never => {
    throw new Error(`任务模板插件 ${pluginId} 的定义无效：${message}`);
  };
  if (typeof template.id !== 'string' || template.id.trim() === '') fail('id 不能为空');
  if (typeof template.name !== 'string' || template.name.trim() === '') fail('name 不能为空');
  if (typeof template.summary !== 'string' || template.summary.trim() === '') {
    fail('summary 不能为空');
  }
  if (typeof template.goal !== 'string' || template.goal.trim() === '') fail('goal 不能为空');
  if (!ROLE_NAMES.includes(template.role)) fail(`未知角色 ${String(template.role)}`);
  if (!DELIVERABLE_PROFILES.includes(template.deliverableProfile)) {
    fail(`未知交付物形态 ${String(template.deliverableProfile)}`);
  }
  if (!Array.isArray(template.deliverables) || template.deliverables.length === 0) {
    fail('deliverables 不能为空');
  }
  for (const deliverable of template.deliverables) {
    if (!DELIVERABLE_TYPES.includes(deliverable.type)) {
      fail(`未知交付物类型 ${String(deliverable.type)}`);
    }
  }
  if (!Array.isArray(template.acceptance) || template.acceptance.length === 0) {
    fail('acceptance 不能为空');
  }
  for (const criterion of template.acceptance) {
    if (!ACCEPTANCE_TYPES.includes(criterion.type)) {
      fail(`验收类型非法：${String(criterion.type)}`);
    }
    if (criterion.type === 'command' && !criterion.check) fail('command 验收必须提供 check');
  }
  // 模板不能绕过人工验收：固定 unverified_only，禁止 auto。
  if (template.acceptancePolicy !== 'unverified_only') {
    fail('acceptancePolicy 只能是 unverified_only');
  }
  if (!Array.isArray(template.writeScope)) fail('writeScope 必须是数组');
  if (typeof template.allowAutoMerge !== 'boolean') fail('allowAutoMerge 必须是布尔值');
  if (
    (template.role === 'verifier' || template.role === 'researcher') &&
    template.writeScope.length > 0
  ) {
    fail('只读角色的模板不能声明写入范围');
  }
}
