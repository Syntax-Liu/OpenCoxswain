import type { EmployeeRegistry } from '@opencoxswain/plugin-api';
import {
  ACCEPTANCE_TYPES,
  ROLE_NAMES,
  type EmployeeDefinition,
  type RoleName,
} from '@opencoxswain/shared';

/** 员工注册表插件：只负责登记与查询，不内置任何角色数据。 */
export class InMemoryEmployeeRegistry implements EmployeeRegistry {
  private readonly byRole = new Map<RoleName, EmployeeDefinition>();

  register(definition: Omit<EmployeeDefinition, 'pluginId'>, pluginId: string): () => void {
    validate(definition, pluginId);
    const existing = this.byRole.get(definition.role);
    if (existing) {
      throw new Error(
        `角色 ${definition.role} 已被员工插件 ${existing.pluginId} 占用，${pluginId} 不能重复注册`,
      );
    }
    this.byRole.set(definition.role, { ...definition, pluginId });
    return () => {
      if (this.byRole.get(definition.role)?.pluginId === pluginId) {
        this.byRole.delete(definition.role);
      }
    };
  }

  get(role: RoleName): EmployeeDefinition | undefined {
    return this.byRole.get(role);
  }

  list(): EmployeeDefinition[] {
    return [...this.byRole.values()];
  }
}

function validate(definition: Omit<EmployeeDefinition, 'pluginId'>, pluginId: string): void {
  const fail = (message: string): never => {
    throw new Error(`员工插件 ${pluginId} 的定义无效：${message}`);
  };
  if (typeof definition.id !== 'string' || definition.id.trim() === '') fail('id 不能为空');
  if (!ROLE_NAMES.includes(definition.role)) fail(`未知角色 ${String(definition.role)}`);
  if (typeof definition.name !== 'string' || definition.name.trim() === '') fail('name 不能为空');
  if (!Array.isArray(definition.skills) || definition.skills.length === 0) fail('skills 不能为空');
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) fail('tools 不能为空');
  if (!Array.isArray(definition.permissions)) fail('permissions 必须是数组');
  if (typeof definition.readOnly !== 'boolean') fail('readOnly 必须是布尔值');
  if (!Array.isArray(definition.acceptanceDefaults) || definition.acceptanceDefaults.length === 0) {
    fail('acceptanceDefaults 不能为空');
  }
  for (const criterion of definition.acceptanceDefaults) {
    if (!ACCEPTANCE_TYPES.includes(criterion.type)) fail(`验收类型非法：${criterion.type}`);
    if (criterion.type === 'command' && !criterion.check) fail('command 验收必须提供 check');
  }
  if (definition.readOnly && definition.tools.includes('write')) {
    fail('只读员工不能声明 write 工具');
  }
}
