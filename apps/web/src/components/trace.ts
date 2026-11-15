import type { MessageDto } from '../api.js';

/**
 * 轨迹页的数据整理。
 *
 * ## 轨迹是什么
 *
 * 对话页只显示「人说的」和「Assistant 最终说的」。
 * 中间过程——每一次工具调用、每一次模型思考——都在这里。
 *
 * 为什么单独一页：过程信息密度高，混在对话里会淹没正文；
 * 但排查问题、审计行为时又必须能看到。
 *
 * ## 结构照 DSH
 *
 * 1. 顶部统计（时长 / 轮次 / 调用数）
 * 2. 时间轴（每次调用一段，按类型着色）
 * 3. 明细列表（工具 / 助手 / 你，各自一行）
 */

/** 一次调用的类型。决定时间轴颜色和列表标签。 */
export type TraceKind = 'user' | 'assistant' | 'tool';

export interface TraceEntry {
  readonly id: string;
  readonly kind: TraceKind;
  /** 列表左侧的标签文字。 */
  readonly label: string;
  /** 摘要：工具调用是命令/路径，助手是回复，用户是原话。 */
  readonly title: string;
  /** 完整内容（点开看）。 */
  readonly detail: string;
  readonly at: number;
}

export interface TraceSummary {
  readonly entries: readonly TraceEntry[];
  readonly total: number;
  /** 各类型计数，用于顶部统计。 */
  readonly counts: { readonly user: number; readonly assistant: number; readonly tool: number };
  /** 时间跨度（毫秒）。少于 2 条时为 0。 */
  readonly spanMs: number;
}

/**
 * 判断一条消息是不是工具调用。
 *
 * **不能只看 role**：运行时的工具轨迹是记成
 * `role: 'user'` + `source: 'tool'`（调用）
 * `role: 'assistant'` + `source: 'tool-result'`（结果）。
 * 因为这两条会回到模型的上下文里，role 必须符合 LLM 协议的 user/assistant。
 * 区分工具与真实对话，靠的是 `source`。
 *
 * 早期按 `role === 'tool'` 判断，结果工具调用永远是 0 条。
 */
export function isToolSource(source: string): boolean {
  return source === 'tool' || source === 'tool-result';
}

/** 工具调用摘要：从 JSON 参数里取出最有辨识度的一个值。 */
export function summarizeToolCall(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '（空）';

  // 优先取这些字段——它们最能说明"这次干了什么"
  const KEYS = ['command', 'path', 'pattern', 'query', 'goal'];
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        return `${key}: ${truncate(value.trim(), 160)}`;
      }
    }
    // 没有熟悉的字段就退回第一对键值
    const firstKey = Object.keys(parsed)[0];
    if (firstKey !== undefined) {
      return `${firstKey}: ${truncate(String(parsed[firstKey]), 160)}`;
    }
  } catch {
    // 不是 JSON 就按纯文本处理
  }
  return truncate(trimmed, 160);
}

/** 助手回复摘要：把多行压成一行，去掉 Markdown 标记。 */
export function summarizeAssistant(content: string): string {
  const oneLine = content
    .replace(/```[\s\S]*?```/g, '〔代码块〕')
    .replace(/[#*`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(oneLine || '（空回复）', 160);
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

const LABELS: Record<TraceKind, string> = {
  user: '你',
  assistant: '助手',
  tool: '工具',
};

/**
 * 把原始消息整理成轨迹条目。
 *
 * **不过滤 internal**：内部通知（如 Agent 结算）正是排查时最想看的，
 * 它们在对话页被隐藏，在这里应当可见，并标注出来。
 */
export function buildTrace(messages: readonly MessageDto[]): TraceSummary {
  const entries: TraceEntry[] = [];

  for (const message of messages) {
    if (message.role === 'system') continue;

    // 工具轨迹藏在 source 里，不是 role 里（见 isToolSource 的说明）
    const isTool = isToolSource(message.source);
    const isToolResult = message.source === 'tool-result';

    const kind: TraceKind = isTool
      ? 'tool'
      : message.role === 'tool' || message.role === 'user'
        ? 'user'
        : 'assistant';

    // internal 的 user 消息其实是系统通知，标出来免得被误读成用户发言
    const isInternalNotice = kind === 'user' && message.internal === true;

    const label = isTool
      ? isToolResult
        ? '结果'
        : '工具'
      : isInternalNotice
        ? '系统通知'
        : LABELS[kind];

    entries.push({
      id: message.id,
      kind,
      label,
      title: isTool
        ? isToolResult
          ? truncate(message.content, 160)
          : summarizeToolCall(extractToolArgs(message.content))
        : kind === 'user'
          ? truncate(message.content, 160)
          : summarizeAssistant(message.content),
      detail: message.content,
      at: message.at,
    });
  }

  // 按时间排序：SSE 增量到达时顺序可能乱
  entries.sort((a, b) => a.at - b.at);

  const counts = {
    user: entries.filter((e) => e.kind === 'user').length,
    assistant: entries.filter((e) => e.kind === 'assistant').length,
    tool: entries.filter((e) => e.kind === 'tool').length,
  };

  const spanMs =
    entries.length >= 2 ? (entries[entries.length - 1]!.at ?? 0) - (entries[0]!.at ?? 0) : 0;

  return { entries, total: entries.length, counts, spanMs };
}

/**
 * 工具调用的内容格式是 `` `toolName` {json参数} ``。
 *
 * 取出工具名和参数字符串，交给 summarizeToolCall 提炼。
 */
export function extractToolArgs(content: string): string {
  // 形如：`run_command` {"command":"pnpm test"}
  const match = /^`([^`]+)`\s*([\s\S]*)$/.exec(content.trim());
  if (match) {
    const [, name, rest] = match;
    const args = rest?.trim() ?? '';
    if (!args) return `{"tool":"${name}"}`;
    // 参数本身通常就是 JSON，直接交给摘要函数
    return args;
  }
  return content;
}

/** 工具名（用于列表标签）。 */
export function extractToolName(content: string): string | null {
  const match = /^`([^`]+)`/.exec(content.trim());
  return match ? (match[1] ?? null) : null;
}

/** 时间轴分段的宽度比例（每段等宽，但保留类型信息供着色）。 */
export function timelineSegments(trace: TraceSummary): TraceKind[] {
  return trace.entries.map((e) => e.kind);
}

/** 顶部统计的可读文本。 */
export function describeSpan(ms: number): string {
  if (ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;

  // 超过一小时就用小时表达。
  // 早期的实现只算到分钟，结果跨了 20 小时的会话显示成"1397 分 57 秒"，
  // 既难读也不像人话。
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const leftoverMinutes = minutes % 60;
    return leftoverMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${leftoverMinutes} 分`;
  }

  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}
