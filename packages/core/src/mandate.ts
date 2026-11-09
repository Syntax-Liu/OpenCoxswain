import type { MandateStrength, Task, TaskMandate } from '@opencoxswain/shared';

/** 工具别名归一：运行时上报的具体工具名映射到员工声明的工具类别。 */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'shell',
  sh: 'shell',
  exec: 'shell',
  run_command: 'shell',
  shell_exec: 'shell',
  read_file: 'read',
  file_read: 'read',
  write_file: 'write',
  file_write: 'write',
  edit: 'write',
  edit_file: 'write',
  apply_patch: 'write',
  run_test: 'test',
  test_run: 'test',
};

export function canonicalTool(tool: string): string {
  return TOOL_ALIASES[tool] ?? tool;
}

export interface IssueMandateOptions {
  id: string;
  issuedBy: TaskMandate['issuedBy'];
  /** 员工插件包声明的工具白名单。 */
  allowedTools: string[];
  ttlMs: number;
  now?: number;
}

/** 从任务单派生授权：写域来自 write_scope，工具来自员工插件包。 */
export function issueMandate(task: Task, options: IssueMandateOptions): TaskMandate {
  const writePaths = [...(task.contract.write_scope ?? [])];
  const strength: MandateStrength = writePaths.length === 0 ? 'read' : 'write';
  const at = options.now ?? Date.now();
  return {
    id: options.id,
    taskId: task.id,
    scope: {
      writePaths,
      allowedTools: [...new Set(options.allowedTools.map(canonicalTool))],
      network: false,
      install: false,
    },
    strength,
    budget: task.contract.budget,
    expiresAt: at + options.ttlMs,
    issuedBy: options.issuedBy,
    issuedAt: at,
  };
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

/** 目标路径是否落在授权写域内；空写域或 ** 视为全仓库。 */
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

/** 任务单声明的写域必须被授权完全覆盖，否则视为扩权。 */
export function mandateCoversWriteScope(mandate: TaskMandate, writeScope: string[]): string[] {
  return writeScope
    .filter((scope) => !isWildcard(scope))
    .filter((scope) => !scopeCovers(mandate.scope.writePaths, scope))
    .map((scope) => `写域 ${scope} 超出任务授权`);
}

export function mandateAllowsTool(mandate: TaskMandate, tool: string): boolean {
  return mandate.scope.allowedTools.includes(canonicalTool(tool));
}

function actionPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const value = record.path ?? record.file ?? record.target;
  return typeof value === 'string' ? value : null;
}

/** 单次工具调用的授权校验；通过返回 null。 */
export function mandateViolation(
  mandate: TaskMandate,
  tool: string,
  input: unknown,
  now = Date.now(),
): string | null {
  if (mandate.expiresAt <= now) return '任务授权已过期';
  if (!mandateAllowsTool(mandate, tool)) return `工具 ${tool} 不在授权范围`;
  if (canonicalTool(tool) === 'write') {
    const target = actionPath(input);
    if (target && !scopeCovers(mandate.scope.writePaths, target)) {
      return `写入路径 ${target} 超出授权写域`;
    }
  }
  return null;
}

/** 执行前的整体有效性检查。 */
export function mandateProblems(mandate: TaskMandate | null, now = Date.now()): string[] {
  if (!mandate) return ['任务未签发授权凭证'];
  return mandate.expiresAt <= now ? ['任务授权已过期'] : [];
}
