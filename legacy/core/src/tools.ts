export const STEWARD_TOOL_NAMES_V0 = [
  'spawn_worker',
  'assign_task',
  'query_worker',
  'collect_result',
  'ask_human',
] as const;

export type StewardToolName = (typeof STEWARD_TOOL_NAMES_V0)[number];

export interface StewardToolSpec {
  name: StewardToolName;
  description: string;
}

/** 总管在 v0 只能调用元操作；文件、shell、git、网络都不在注册表里。 */
export const STEWARD_TOOLS_V0: readonly StewardToolSpec[] = [
  { name: 'spawn_worker', description: '创建员工实例，绑定角色、运行时与模型' },
  { name: 'assign_task', description: '派发任务，校验依赖、写域与预算' },
  { name: 'query_worker', description: '查询员工状态摘要，不读原始日志' },
  { name: 'collect_result', description: '收集摘要与产物，结果走结构化 schema' },
  { name: 'ask_human', description: '需要用户拍板时阻塞等待' },
];

export const STEWARD_FORBIDDEN_CAPABILITIES = [
  'file_read',
  'file_write',
  'shell',
  'network',
  'git',
  'install_dependency',
  'model_call',
] as const;

export const DANGEROUS_ACTIONS = [
  'delete',
  'push',
  'publish',
  'pay',
  'external_send',
  'install_system_dependency',
] as const;

export type DangerousAction = (typeof DANGEROUS_ACTIONS)[number];
