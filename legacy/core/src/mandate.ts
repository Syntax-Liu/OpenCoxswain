import type {
  Capability,
  Project,
  RoleName,
  Task,
  TaskMandate,
} from '@opencoxswain/shared';

/** 工具别名归一：运行时上报的具体工具名映射到员工声明的工具类别。 */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'shell',
  sh: 'shell',
  exec: 'shell',
  run_command: 'shell',
  shell_exec: 'shell',
  proc: 'shell',
  read_file: 'read',
  file_read: 'read',
  write_file: 'write',
  file_write: 'write',
  edit: 'write',
  edit_file: 'write',
  apply_patch: 'write',
  delete: 'delete',
  remove: 'delete',
  unlink: 'delete',
  rm: 'delete',
  run_test: 'test',
  test_run: 'test',
  // OpenCode CLI 的检索/列举工具等价于读仓库，不授予额外能力。
  glob: 'read',
  grep: 'read',
  list: 'read',
  ls: 'read',
  list_dir: 'read',
  list_files: 'read',
  search_files: 'read',
  find_files: 'read',
  // OpenCode 用 patch 做结构化改写。
  patch: 'write',
  // 待办清单是运行时内部状态，不触达仓库与网络，按只读放行。
  todowrite: 'read',
  todoread: 'read',
  fetch_url: 'web_search',
  webfetch: 'web_search',
  search: 'web_search',
  web_search: 'web_search',
  fetch: 'web_search',
  send_email: 'email',
  send_mail: 'email',
  send_message: 'send',
  http_post: 'send',
};

export function canonicalTool(tool: string): string {
  return TOOL_ALIASES[tool] ?? tool;
}

const CAPABILITY_BY_TOOL: Record<string, Capability> = {
  read: 'fs.read',
  write: 'fs.write',
  delete: 'fs.write',
  shell: 'proc.spawn',
  test: 'proc.spawn',
  web_search: 'net.read',
  send: 'net.send',
  email: 'net.send',
  webhook: 'net.send',
  notify: 'net.send',
  secrets: 'secrets.use',
};

/** 工具调用所需能力；识别不到返回 null（调用方应拒绝而不是放行）。 */
export function toolCapability(tool: string): Capability | null {
  return CAPABILITY_BY_TOOL[canonicalTool(tool).toLowerCase()] ?? null;
}

export interface IssueMandateOptions {
  id: string;
  issuedBy: TaskMandate['issuedBy'];
  /** 员工插件包声明的能力集合。 */
  capabilities: Capability[];
  /** 项目工作目录；写入不得越出。 */
  root: string;
  roles: RoleName[];
  ttlMs: number;
  now?: number;
}

/** 从任务单与项目边界派生授权：能力集合 + 根目录 + 可执行角色。 */
export function issueMandate(task: Task, options: IssueMandateOptions): TaskMandate {
  const at = options.now ?? Date.now();
  return {
    id: options.id,
    taskId: task.id,
    capabilities: [...new Set(options.capabilities)],
    root: options.root,
    roles: [...new Set(options.roles)],
    budget: task.contract.budget,
    expiresAt: at + options.ttlMs,
    issuedBy: options.issuedBy,
    issuedAt: at,
  };
}

/** 项目默认能力边界：本地读写与跑命令不受项目开关限制；联网与外发由三问决定。 */
export function projectCapabilities(project: Project): Capability[] {
  const capabilities: Capability[] = ['fs.read', 'fs.write', 'proc.spawn'];
  if (project.allowNetwork) capabilities.push('net.read');
  if (project.allowExternalSend) capabilities.push('net.send');
  return capabilities;
}

/** 员工声明但项目默认不授予的能力。 */
export function capabilityDiff(
  requested: Capability[],
  granted: Capability[],
): Capability[] {
  return requested.filter((capability) => !granted.includes(capability));
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isWildcard(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === '' || normalized === '*' || normalized === '**' || normalized === '**/*';
}

/** 目标路径是否落在写域内；空写域或 ** 视为全仓库。 */
export function scopeCovers(writePaths: string[], target: string): boolean {
  const normalizedTarget = normalizePath(target);
  if (!normalizedTarget) return true;
  return writePaths.some((scope) => {
    if (isWildcard(scope)) return true;
    const normalizedScope = normalizePath(scope).replace(/\/\*+$/, '');
    return (
      normalizedTarget === normalizedScope ||
      normalizedTarget.startsWith(`${normalizedScope}/`)
    );
  });
}

export function mandateAllowsCapability(mandate: TaskMandate, capability: Capability): boolean {
  return mandate.capabilities.includes(capability);
}

export function mandateAllowsTool(mandate: TaskMandate, tool: string): boolean {
  const capability = toolCapability(tool);
  return capability !== null && mandateAllowsCapability(mandate, capability);
}

export function mandateAllowsRole(mandate: TaskMandate, role: RoleName): boolean {
  return mandate.roles.includes(role);
}

function actionPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const value = record.path ?? record.file ?? record.target;
  return typeof value === 'string' ? value : null;
}

function isAbsolute(target: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\') || target.startsWith('/');
}

/** 绝对路径转成相对 workspace 的路径；越出 workspace 与 root 返回 null。 */
function relativeToWorkspace(target: string, workspace: string, root: string): string | null {
  const normalizedTarget = normalizePath(target);
  for (const base of [workspace, root]) {
    const normalizedBase = normalizePath(base);
    if (!normalizedBase) continue;
    if (normalizedTarget === normalizedBase) return '';
    if (normalizedTarget.startsWith(`${normalizedBase}/`)) {
      return normalizedTarget.slice(normalizedBase.length + 1);
    }
  }
  return null;
}

export interface MandateContext {
  now?: number;
  /** 任务单声明的相对写域；缺省不限制相对路径。 */
  writeScope?: string[];
  /** 该任务的 worktree；绝对路径必须落在 worktree 或授权根目录内。 */
  workspace?: string;
}

/** 单次工具调用的授权校验；通过返回 null。 */
export function mandateViolation(
  mandate: TaskMandate,
  tool: string,
  input: unknown,
  context: MandateContext = {},
): string | null {
  const now = context.now ?? Date.now();
  if (mandate.expiresAt <= now) return '任务授权已过期';

  const capability = toolCapability(tool);
  if (!capability) return `工具 ${tool} 未声明能力，拒绝执行`;
  if (!mandateAllowsCapability(mandate, capability)) {
    return `工具 ${tool} 需要能力 ${capability}，不在任务授权范围`;
  }

  if (capability !== 'fs.write') return null;
  const target = actionPath(input);
  if (!target) return null;

  let relative = target;
  if (isAbsolute(target)) {
    const workspace = context.workspace ?? mandate.root;
    const mapped = relativeToWorkspace(target, workspace, mandate.root);
    if (mapped === null) return `写入路径 ${target} 超出授权根目录 ${mandate.root}`;
    relative = mapped;
  }
  if (context.writeScope && !scopeCovers(context.writeScope, relative)) {
    return `写入路径 ${target} 超出任务写域`;
  }
  return null;
}

/** 执行前的整体有效性检查。 */
export function mandateProblems(mandate: TaskMandate | null, now = Date.now()): string[] {
  if (!mandate) return ['任务未签发授权凭证'];
  return mandate.expiresAt <= now ? ['任务授权已过期'] : [];
}
