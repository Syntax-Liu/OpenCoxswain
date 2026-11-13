import type { PluginContext } from '@opencoxswain/plugin-api';
import type { EmployeeDefinition } from '@opencoxswain/shared';

/**
 * 员工插件包工厂：一个员工包 = 角色 + 技能 + 工具白名单 + 权限 + 默认验收标准。
 * 外部插件只要在自己的入口文件里调用同一个工厂，即可安装新的员工。
 */
export function employeePack(
  definition: Omit<EmployeeDefinition, 'pluginId'>,
): (ctx: PluginContext) => void {
  return (ctx) => {
    ctx.requirePermission('employee:provide');
    ctx.service('employees').register(definition, ctx.id);
  };
}
