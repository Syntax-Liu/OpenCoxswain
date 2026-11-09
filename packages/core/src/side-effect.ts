import { createHash } from 'node:crypto';
import type { SideEffectKind } from '@opencoxswain/shared';
import { canonicalTool } from './mandate.js';

export interface SideEffectIntent {
  kind: SideEffectKind;
  target: string;
  reversible: boolean;
}

const WRITE_TOOLS = new Set(['write']);
const DELETE_TOOLS = new Set(['delete', 'remove', 'unlink', 'rm']);
const SEND_TOOLS = new Set(['send', 'email', 'webhook', 'notify', 'message']);
const PROC_TOOLS = new Set(['shell', 'exec', 'proc', 'test']);

/** 只有文件类副作用可能被补偿；进程与外发不承诺撤销。 */
const REVERSIBLE: Record<SideEffectKind, boolean> = {
  'fs.write': true,
  'fs.delete': true,
  'proc.exec': false,
  'net.send': false,
};

/** 去重策略：同一幂等键只有第一次生效；进程执行只记账不去重。 */
const DEDUPE: Record<SideEffectKind, boolean> = {
  'fs.write': true,
  'fs.delete': true,
  'proc.exec': false,
  'net.send': true,
};

function record(input: unknown): Record<string, unknown> | null {
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

function actionText(input: unknown): string {
  const fields = record(input);
  if (!fields) return typeof input === 'string' ? input : '';
  const parts: string[] = [];
  for (const key of ['command', 'cmd', 'script', 'query', 'url', 'path', 'target', 'file', 'to']) {
    const found = firstString(fields[key]);
    if (found) parts.push(found);
  }
  return parts.join(' ');
}

function targetOf(input: unknown): string {
  const fields = record(input);
  if (!fields) return typeof input === 'string' ? input : '';
  return (
    firstString(fields.path) ??
    firstString(fields.file) ??
    firstString(fields.target) ??
    firstString(fields.url) ??
    firstString(fields.to) ??
    firstString(fields.command) ??
    firstString(fields.cmd) ??
    firstString(fields.query) ??
    ''
  );
}

const DELETE_COMMAND = /\b(rm|del|erase|rmdir)\b|\bRemove-Item\b|\bunlink\b/i;
const SEND_COMMAND = /\b(sendmail|mailx|webhook|smtp)\b|\bcurl\b[^\n]*\s-X\s*(POST|PUT|PATCH|DELETE)\b/i;

/** 从一次工具调用识别副作用类别；纯读操作返回 null。 */
export function classifySideEffect(tool: string, input: unknown): SideEffectIntent | null {
  const name = canonicalTool(tool).toLowerCase();
  const text = actionText(input);
  const target = targetOf(input);

  let kind: SideEffectKind | null = null;
  if (WRITE_TOOLS.has(name)) kind = 'fs.write';
  else if (DELETE_TOOLS.has(name)) kind = 'fs.delete';
  else if (SEND_TOOLS.has(name)) kind = 'net.send';
  else if (PROC_TOOLS.has(name)) kind = 'proc.exec';
  else if (SEND_COMMAND.test(text)) kind = 'net.send';
  else if (DELETE_COMMAND.test(text)) kind = 'fs.delete';

  if (!kind) return null;
  return { kind, target: target || name, reversible: REVERSIBLE[kind] };
}

export function sideEffectDeduped(kind: SideEffectKind): boolean {
  return DEDUPE[kind];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = stable((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** 幂等键 = sha256(taskId + stepId + tool + normalizedArgs)。 */
export function sideEffectKey(
  taskId: string,
  tool: string,
  input: unknown,
  stepId = '',
): string {
  const normalized = JSON.stringify(stable(input ?? null));
  return createHash('sha256')
    .update(`${taskId}\u0000${stepId}\u0000${canonicalTool(tool)}\u0000${normalized}`)
    .digest('hex');
}
