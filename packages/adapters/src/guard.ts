export const DANGEROUS_CATEGORIES = [
  'delete',
  'push',
  'publish',
  'pay',
  'external_send',
] as const;

export type DangerousCategory = (typeof DANGEROUS_CATEGORIES)[number];

export interface ActionRequest {
  tool: string;
  input: unknown;
  category: DangerousCategory;
}

export type ActionDecision = 'approved' | 'rejected';

/**
 * 危险动作闸门。
 *
 * 运行时在真正执行动作前调用 `request`；`approved` 才继续，`rejected` 则终止。
 * 只有能在执行前挂起的运行时（当前为 Mock）实现原生闸门；外部进程运行时由调度器
 * 在事件边界做冻结处理。
 */
export interface ApprovalGate {
  request(action: ActionRequest): Promise<ActionDecision>;
}

function collectStrings(value: unknown, depth: number, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (depth <= 0 || typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth - 1, out);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStrings(item, depth - 1, out);
  }
}

/** 只提取可能承载命令/地址的字段，避免把文件内容误判为命令。 */
function actionText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['command', 'cmd', 'script', 'query', 'url', 'args', 'path', 'target']) {
    collectStrings(record[key], 2, parts);
  }
  return parts.join(' ');
}

const PUSH = /\bgit\s+push\b/i;
const PUBLISH =
  /\b(npm|pnpm|yarn|dotnet|nuget|pip|cargo)\s+publish\b|\bgh\s+release\b|\bdocker\s+push\b/i;
const PAY = /\b(stripe|paypal)\b|\b(payment|charge|refund|invoice|checkout)\b|\bpay\b/i;
const EXTERNAL_SEND =
  /\b(git\s+send-email|sendmail|mailx)\b|\b(slack|telegram|webhook|smtp)\b|\bcurl\b[^\n]*\s-X\s*(POST|PUT|PATCH|DELETE)\b|\bInvoke-(RestMethod|WebRequest)\b/i;
const DELETE =
  /\b(rm|del|erase|rmdir)\b\s+\S|\bgit\s+clean\b|\bgit\s+branch\s+-D\b|\bRemove-Item\b|\bdrop\s+(table|database)\b|\bunlink\b/i;

/** 识别 PRD 要求人审的五类危险动作；识别不到返回 null。 */
export function classifyAction(tool: string, input: unknown): DangerousCategory | null {
  const name = tool.toLowerCase();
  if (/(^|[._-])(delete|remove|unlink|rm)([._-]|$)/.test(name)) return 'delete';
  if (/(^|[._-])(push|deploy)([._-]|$)/.test(name)) return 'push';
  if (/(^|[._-])(publish|release)([._-]|$)/.test(name)) return 'publish';
  if (/(^|[._-])(pay|payment|checkout)([._-]|$)/.test(name)) return 'pay';
  if (/(^|[._-])(send|email|webhook|notify)([._-]|$)/.test(name)) return 'external_send';

  const text = actionText(input);
  if (text.trim() === '') return null;
  if (PUSH.test(text)) return 'push';
  if (PUBLISH.test(text)) return 'publish';
  if (PAY.test(text)) return 'pay';
  if (EXTERNAL_SEND.test(text)) return 'external_send';
  if (DELETE.test(text)) return 'delete';
  return null;
}

export function actionKey(action: Pick<ActionRequest, 'tool' | 'input'>): string {
  return JSON.stringify({ tool: action.tool, input: action.input ?? null });
}
