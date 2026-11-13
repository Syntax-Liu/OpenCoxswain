import type {
  EventService,
  ScheduleService,
  StewardService,
  StorageService,
} from '@opencoxswain/plugin-api';
import type { Schedule, ScheduleRun } from '@opencoxswain/shared';
import { now } from '@opencoxswain/shared';
import { isTerminal } from '@opencoxswain/core';
import { AppError } from './errors.js';

/** 最小间隔 1 分钟，避免把定时任务当成压测入口。 */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 30 * 24 * 60;

export interface ScheduleDeps {
  store: StorageService;
  bus: EventService;
  steward: StewardService;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * 定时任务：到点只调用总管生成任务单，任务照常停在待审批。
 * 已存在未完成任务时整次跳过，不抢占、不排队、不自动开工。
 */
export class Schedules implements ScheduleService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ScheduleDeps) {}

  list(projectId?: string | null): Schedule[] {
    return this.deps.store.listSchedules(projectId);
  }

  create(input: {
    projectId: string;
    title: string;
    goal: string;
    templateId?: string | null;
    intervalMinutes: number;
    enabled?: boolean;
  }): Schedule {
    if (!this.deps.store.getProject(input.projectId)) {
      throw new AppError('项目不存在', 404);
    }
    const title = input.title.trim();
    const goal = input.goal.trim();
    if (title === '') throw new AppError('定时任务标题不能为空');
    if (goal === '') throw new AppError('定时任务目标不能为空');
    const intervalMinutes = Math.trunc(input.intervalMinutes);
    if (
      !Number.isFinite(intervalMinutes) ||
      intervalMinutes < MIN_INTERVAL_MINUTES ||
      intervalMinutes > MAX_INTERVAL_MINUTES
    ) {
      throw new AppError(`间隔必须是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟之间的整数`);
    }
    const templateId = input.templateId?.trim() || null;
    const enabled = input.enabled !== false;
    return this.deps.store.insertSchedule({
      projectId: input.projectId,
      title,
      goal,
      templateId,
      intervalMinutes,
      enabled,
      nextRunAt: this.nextRunAt(intervalMinutes),
    });
  }

  setEnabled(id: string, enabled: boolean): Schedule {
    const schedule = this.require(id);
    return this.deps.store.updateSchedule(schedule.id, {
      enabled,
      // 重新启用从当前时刻开始计时，不补跑停用期间错过的时段。
      ...(enabled ? { nextRunAt: this.nextRunAt(schedule.intervalMinutes) } : {}),
    });
  }

  remove(id: string): boolean {
    return this.deps.store.deleteSchedule(id);
  }

  run(id: string): Promise<ScheduleRun> {
    const schedule = this.require(id);
    if (!schedule.enabled) throw new AppError('定时任务已停用，请先启用', 409);
    return this.exclusive(() => this.fire(schedule, now()));
  }

  async tick(at: number = now()): Promise<ScheduleRun[]> {
    const due = this.deps.store.listDueSchedules(at);
    const runs: ScheduleRun[] = [];
    for (const schedule of due) {
      try {
        runs.push(await this.exclusive(() => this.fire(schedule, at)));
      } catch (error) {
        this.deps.log?.('定时任务触发失败', error);
      }
    }
    return runs;
  }

  private async fire(schedule: Schedule, at: number): Promise<ScheduleRun> {
    const intervalMs = schedule.intervalMinutes * 60_000;
    const nextRunAt = at + intervalMs;
    const project = this.deps.store.getProject(schedule.projectId);
    if (!project) {
      const updated = this.deps.store.updateSchedule(schedule.id, {
        enabled: false,
        nextRunAt,
        lastRunAt: at,
      });
      const reason = '项目已不存在，定时任务已停用';
      this.record(updated, 'schedule.skipped', null, { reason });
      return { schedule: updated, outcome: 'skipped', taskId: null, reason };
    }

    const blocked = this.deps.store
      .listRootTasks(project.id)
      .find((root) => !isTerminal(root.status));
    if (blocked) {
      const reason = `已有未完成任务「${blocked.title}」，本次跳过`;
      const updated = this.deps.store.updateSchedule(schedule.id, { nextRunAt, lastRunAt: at });
      this.record(updated, 'schedule.skipped', null, { reason, taskStatus: blocked.status });
      return { schedule: updated, outcome: 'skipped', taskId: null, reason };
    }

    try {
      const { root } = await this.deps.steward.createPlan(project.id, {
        goal: schedule.goal,
        ...(schedule.templateId ? { templateId: schedule.templateId } : {}),
      });
      const updated = this.deps.store.updateSchedule(schedule.id, {
        nextRunAt,
        lastRunAt: at,
        lastTaskId: root.id,
      });
      this.record(updated, 'schedule.fired', root.id, { taskTitle: root.title });
      return { schedule: updated, outcome: 'created', taskId: root.id, reason: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const updated = this.deps.store.updateSchedule(schedule.id, {
        nextRunAt,
        lastRunAt: at,
      });
      this.record(updated, 'schedule.failed', null, { reason });
      return { schedule: updated, outcome: 'failed', taskId: null, reason };
    }
  }

  private record(
    schedule: Schedule,
    type: string,
    taskId: string | null,
    payload: Record<string, unknown>,
  ): void {
    const event = this.deps.store.appendEvent({
      taskId,
      type,
      payload: {
        scheduleId: schedule.id,
        scheduleTitle: schedule.title,
        projectId: schedule.projectId,
        ...payload,
      },
    });
    this.deps.bus.publish(event);
  }

  private nextRunAt(intervalMinutes: number): number {
    return now() + intervalMinutes * 60_000;
  }

  private require(id: string): Schedule {
    const schedule = this.deps.store.getSchedule(id);
    if (!schedule) throw new AppError('定时任务不存在', 404);
    return schedule;
  }

  /** 串行触发：避免「立即生成」与到点检查同时写任务单。 */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
