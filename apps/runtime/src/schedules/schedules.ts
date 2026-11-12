/**
 * 定时建议。
 *
 * ## 它到底做什么
 *
 * 到点之后**只生成一条"建议"**，告诉用户"该做这件事了"。
 * 用户点确认才真的派活。
 *
 * ## 为什么不做成"自动开工"
 *
 * 一旦到点就自己跑起来，就破坏了整个产品的前提：**人拍板**。
 * 半夜自动改代码、自动提交，用户第二天打开会看到完全不认识的状态。
 *
 * 所以这里的实现刻意只有两个动作：
 * - `due()`：到点了没？到了就产出一条建议
 * - `dismiss()`：用户说"这次不用"
 *
 * **没有"自动执行"这个 API**，从代码结构上就杜绝被误用。
 */
import { newId, type Store } from '../store/store.js';
import type { TaskTemplate } from '../templates/templates.js';

export type ScheduleFrequency = 'daily' | 'weekly';

export interface ScheduleSpec {
  readonly id: string;
  readonly projectId: string;
  /** 到点生成的建议标题。 */
  readonly title: string;
  /** 建议内容（会原样成为待确认任务的 goal）。 */
  readonly goal: string;
  readonly templateId?: string;
  readonly writeScope: readonly string[];
  readonly frequency: ScheduleFrequency;
  /** daily: 0-23；weekly: 0-6（0=周日）。 */
  readonly hour: number;
  readonly weekday?: number;
  readonly enabled: boolean;
  /** 上次生成建议的时间。 */
  readonly lastFiredAt: number | null;
  readonly createdAt: number;
}

/** 判断某个时刻是否该触发。 */
export function isDue(spec: ScheduleSpec, now: Date): boolean {
  if (!spec.enabled) return false;
  if (now.getHours() !== spec.hour) return false;

  if (spec.frequency === 'weekly') {
    if (spec.weekday !== undefined && now.getDay() !== spec.weekday) return false;
    // 一周内已触发过就跳过
    if (spec.lastFiredAt !== null) {
      const days = (now.getTime() - spec.lastFiredAt) / 86_400_000;
      if (days < 6) return false;
    }
    return true;
  }

  // daily：同一天只触发一次
  if (spec.lastFiredAt !== null) {
    const last = new Date(spec.lastFiredAt);
    if (last.toDateString() === now.toDateString()) return false;
  }
  return true;
}

/** 生成一条建议（**不是任务**）。 */
export interface Suggestion {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly goal: string;
  readonly templateId?: string;
  readonly writeScope: readonly string[];
  readonly createdAt: number;
  /** 永远是 true：定时建议必须经人确认。 */
  readonly requiresConfirmation: true;
}

export function makeSuggestion(spec: ScheduleSpec, now = Date.now()): Suggestion {
  return {
    id: newId('sug'),
    projectId: spec.projectId,
    title: spec.title,
    goal: spec.goal,
    ...(spec.templateId ? { templateId: spec.templateId } : {}),
    writeScope: spec.writeScope,
    createdAt: now,
    requiresConfirmation: true,
  };
}

/**
 * 检查所有定时并在到点时产出建议。
 *
 * 把 `lastFiredAt` 写回，避免同一时段重复建议。
 */
export async function checkSchedules(
  schedules: readonly ScheduleSpec[],
  save: (spec: ScheduleSpec) => Promise<void>,
  now = Date.now(),
): Promise<Suggestion[]> {
  const date = new Date(now);
  const out: Suggestion[] = [];

  for (const spec of schedules) {
    if (!isDue(spec, date)) continue;
    out.push(makeSuggestion(spec, now));
    await save({ ...spec, lastFiredAt: now });
  }
  return out;
}

/** 从模板生成定时任务的基础字段（便于界面一键创建）。 */
export function scheduleFromTemplate(input: {
  projectId: string;
  template: TaskTemplate;
  title: string;
  goal: string;
  frequency: ScheduleFrequency;
  hour: number;
  weekday?: number;
}): ScheduleSpec {
  return {
    id: newId('sch'),
    projectId: input.projectId,
    title: input.title,
    goal: input.goal,
    templateId: input.template.id,
    writeScope: input.template.writeScope,
    frequency: input.frequency,
    hour: input.hour,
    ...(input.weekday !== undefined ? { weekday: input.weekday } : {}),
    enabled: true,
    lastFiredAt: null,
    createdAt: Date.now(),
  };
}
