/**
 * 把工具调用翻译成**人话**的当前步骤描述。
 *
 * ## 为什么需要
 *
 * 用户看到侧栏写着"执行中"，但不知道**在做什么**。
 * 而工具调用本身是有的（`read_file`、`write_file`…），只是没翻译成用户能读的语言。
 *
 * 参考 [design-research/03 A1](../../../../docs/design-research/03-agent-ui-problems.md)：
 *
 * > 命名当前步骤几乎不需要任何成本，并且会改变等待的时间。
 *
 * ## 规则（重要）
 *
 * **只从真实参数里提取，绝不猜。**
 *
 * - 有文件路径 → 「修改 foo.ts」
 * - 没有可提取的对象 → 退化成工具名（「调用 bash」），**不编造内容**
 * - 用户看到的东西必须真实对应正在发生的事（`desktop-agent-ui` 的铁律）
 *
 * ## 为什么用「动词 + 对象」而不是原始工具名
 *
 * `write_file src/auth/login.tsx` 是给开发者看的。
 * 「修改 login.tsx」是给用户看的。同一个系统两拨读者，前端显示后者。
 */
import type { LoopEvent } from '../session/loop.js';

/** 用户可读的步骤描述。 */
export interface StepDescription {
  /** 一句话，例如「修改 login.tsx」。 */
  readonly label: string;
  /** 原始工具名（诊断用，界面上不显示）。 */
  readonly tool: string;
  readonly at: number;
}

/** 从工具参数里挑一个像文件路径的值。 */
function pickPath(args: Record<string, unknown>): string | undefined {
  // 常见键名，按可信度排序
  for (const key of ['path', 'file_path', 'filePath', 'file', 'filename', 'target']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // 有的工具用一个数组（如批量编辑）
  for (const key of ['paths', 'files']) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
      const first = value[0].trim();
      if (first) return value.length > 1 ? `${first} 等 ${value.length} 个文件` : first;
    }
  }
  return undefined;
}

/** 只取文件名，不要整条长路径。 */
function shortName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? path) : path;
}

/** 从命令里提取可读的动作（不展开整条命令）。 */
function pickCommand(args: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      // 只取第一段，避免把整条管道命令塞进界面
      const first = value.trim().split(/[|;&]/)[0]?.trim() ?? '';
      return first || undefined;
    }
  }
  return undefined;
}

/** 从搜索参数提取查询词。 */
function pickQuery(args: Record<string, unknown>): string | undefined {
  for (const key of ['query', 'pattern', 'q', 'search']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 工具名 → 动作。
 *
 * 覆盖本项目内置工具与常见别名（Read / Write / Edit / Bash 这类 CamelCase 写法）。
 * **不在表里的工具不报错**，退化为「调用 <工具名>」。
 */
const ACTIONS: readonly (readonly [RegExp, string, 'path' | 'command' | 'query' | 'none'])[] = [
  [/^(read_file|read|cat|view)$/i, '读取', 'path'],
  [/^(write_file|write|create_file|create)$/i, '写入', 'path'],
  [/^(edit_file|edit|str_replace|apply_patch|patch|multi_edit)$/i, '修改', 'path'],
  [/^(bash|shell|run_command|exec|terminal)$/i, '运行命令', 'command'],
  [/^(glob|list_files|ls|find_files)$/i, '查找文件', 'query'],
  [/^(grep|search|search_code|ripgrep)$/i, '搜索', 'query'],
];

/**
 * 生成步骤描述。
 *
 * @param name 工具名
 * @param args 工具参数（可能缺失或为非法结构）
 */
export function describeStep(
  name: string,
  args: Record<string, unknown> | undefined,
): StepDescription {
  const safeArgs = args ?? {};
  const rule = ACTIONS.find(([pattern]) => pattern.test(name));

  if (!rule) {
    // 未知工具：**不编造**，如实说是哪个工具
    return { label: `调用 ${name}`, tool: name, at: Date.now() };
  }

  const [, verb, target] = rule;

  if (target === 'path') {
    const path = pickPath(safeArgs);
    if (!path) return { label: verb, tool: name, at: Date.now() };
    return { label: `${verb} ${shortName(path)}`, tool: name, at: Date.now() };
  }

  if (target === 'command') {
    const cmd = pickCommand(safeArgs);
    if (!cmd) return { label: verb, tool: name, at: Date.now() };
    // 命令本身可能有敏感内容或很长，只显示很短的前缀
    const preview = cmd.length > 24 ? `${cmd.slice(0, 24)}…` : cmd;
    return { label: `${verb} ${preview}`, tool: name, at: Date.now() };
  }

  if (target === 'query') {
    const query = pickQuery(safeArgs);
    if (!query) return { label: verb, tool: name, at: Date.now() };
    const preview = query.length > 24 ? `${query.slice(0, 24)}…` : query;
    return { label: `${verb} ${preview}`, tool: name, at: Date.now() };
  }

  return { label: verb, tool: name, at: Date.now() };
}

/** 从 loop 事件生成步骤描述；不是工具调用时返回 null。 */
export function stepFromEvent(event: LoopEvent): StepDescription | null {
  if (event.type !== 'tool_call') return null;
  return describeStep(event.name, event.args);
}
