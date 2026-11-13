/**
 * 副作用分类与幂等键。
 *
 * 为什么需要台账：验收只告诉你"通过 / 不通过"，**出事时还需要回答
 * "它到底改了什么"**——改了哪些文件、跑了哪些命令、往外发了什么。
 *
 * 四类副作用：
 *
 * | 类别 | 举例 | 可补偿 | 去重 |
 * | --- | --- | --- | --- |
 * | `fs.write` | `write_file` | ✅ | ✅ |
 * | `fs.delete` | `rm` / `del`（在命令里） | ✅ | ✅ |
 * | `proc.exec` | `run_command` | ❌ | ❌（每次都要记） |
 * | `net.send` | `curl -X POST` | ❌ | ✅ |
 *
 * "可补偿"不等于"能撤销"：文件写删可以重新写回，但**命令与对外发送
 * 一旦发生就收不回来**。台账里会明确标出这一点。
 */
import { createHash } from 'node:crypto';

export const SIDE_EFFECT_KINDS = ['fs.write', 'fs.delete', 'proc.exec', 'net.send'] as const;
export type SideEffectKind = (typeof SIDE_EFFECT_KINDS)[number];

/**
 * 副作用状态。
 *
 * `undone` 是**追加**的状态，不替代 `succeeded`——
 * 一条被撤销的记录仍然是"曾经成功执行过"，只是后来被撤销了。
 * 这样台账能回答"它当时做了什么、后来怎么处理的"。
 */
export type SideEffectState = 'pending' | 'succeeded' | 'failed' | 'rejected' | 'undone';

export interface SideEffectIntent {
  readonly kind: SideEffectKind;
  /** 影响对象：文件路径 / 命令 / URL。可读为主。 */
  readonly target: string;
  /** 是否可能被补偿（重新写回 / 重新创建）。 */
  readonly reversible: boolean;
}

export const KIND_LABEL: Record<SideEffectKind, string> = {
  'fs.write': '写文件',
  'fs.delete': '删文件',
  'proc.exec': '执行命令',
  'net.send': '对外发送',
};

const REVERSIBLE: Record<SideEffectKind, boolean> = {
  'fs.write': true,
  'fs.delete': true,
  // 命令可能改了任何东西，也可能什么都没改——不承诺可补偿。
  'proc.exec': false,
  'net.send': false,
};

/** 只有文件类副作用去重；命令每次都要记（同一条命令跑两次也是两次副作用）。 */
const DEDUPE: Record<SideEffectKind, boolean> = {
  'fs.write': true,
  'fs.delete': true,
  'proc.exec': false,
  'net.send': true,
};

export function sideEffectDeduped(kind: SideEffectKind): boolean {
  return DEDUPE[kind];
}

const DELETE_COMMAND =
  /\b(rm|del|erase|rmdir)\b|\bRemove-Item\b|\bunlink\b|\bgit\s+clean\b|\bgit\s+branch\s+-D\b/i;
const SEND_COMMAND =
  /\b(sendmail|mailx|webhook|smtp)\b|\bcurl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|\bgit\s+push\b|\b(?:npm|pnpm|yarn|cargo)\s+publish\b|\bgit\s+send-email\b/i;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  return null;
}

function targetOf(args: Record<string, unknown>): string {
  return (
    firstString(args.path) ??
    firstString(args.file) ??
    firstString(args.target) ??
    firstString(args.url) ??
    firstString(args.command) ??
    firstString(args.query) ??
    ''
  );
}

/**
 * 从一次工具调用识别副作用；纯读操作返回 null。
 *
 * 顺序很重要：`run_command` 里如果是删除或外发，归到更具体的类别，
 * 而不是笼统的 `proc.exec`——用户看台账时"删了文件"比"跑了命令"更有信息量。
 */
export function classifySideEffect(
  tool: string,
  args: Record<string, unknown>,
): SideEffectIntent | null {
  const target = targetOf(args) || tool;

  if (tool === 'write_file') {
    return { kind: 'fs.write', target, reversible: REVERSIBLE['fs.write'] };
  }

  // **edit_file 也是写文件**——而且是我们推荐模型优先用的方式。
  // 漏掉它等于：Agent 改了文件但台账里没记录、也没有快照、无法撤销。
  if (tool === 'edit_file') {
    return { kind: 'fs.write', target, reversible: REVERSIBLE['fs.write'] };
  }

  if (tool === 'run_command') {
    const command = String(args.command ?? '');
    if (SEND_COMMAND.test(command)) {
      return { kind: 'net.send', target: command.slice(0, 200), reversible: false };
    }
    if (DELETE_COMMAND.test(command)) {
      return { kind: 'fs.delete', target: command.slice(0, 200), reversible: REVERSIBLE['fs.delete'] };
    }
    return { kind: 'proc.exec', target: command.slice(0, 200), reversible: false };
  }

  // 读类工具（read_file / list_dir / search_files）没有副作用。
  return null;
}

/** 稳定序列化：键排序，保证同一参数永远得到同一个幂等键。 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stable((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 幂等键 = sha256(executorId + tool + 规范化参数)。
 *
 * 用途：同一次派活里重复写同一个文件，台账不重复记两条。
 */
export function sideEffectKey(
  executorId: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const normalized = JSON.stringify(stable(args));
  return createHash('sha256')
    .update(`${executorId}\u0000${tool}\u0000${normalized}`)
    .digest('hex');
}
