/**
 * 定时配置的持久化。
 *
 * 用 JSON 文件而不是数据库表：定时配置是**个位数条**的小数据，
 * 而且用户可能会想直接看/改这个文件。放进 SQLite 反而更难查。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ScheduleSpec } from './schedules.js';

/** 存储抽象：文件实现用于生产，内存实现用于测试与未配置时。 */
export interface ScheduleStorage {
  load(): Promise<ScheduleSpec[]>;
  save(spec: ScheduleSpec): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 内存实现。不持久化，重启即失效——只在没配置存储时兜底。 */
export class MemoryScheduleStore implements ScheduleStorage {
  private items: ScheduleSpec[] = [];

  async load(): Promise<ScheduleSpec[]> {
    return [...this.items];
  }

  async save(spec: ScheduleSpec): Promise<void> {
    const index = this.items.findIndex((s) => s.id === spec.id);
    if (index >= 0) this.items[index] = spec;
    else this.items.push(spec);
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((s) => s.id !== id);
  }
}

export class ScheduleStore implements ScheduleStorage {
  constructor(private readonly file: string) {}

  async load(): Promise<ScheduleSpec[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter(isSchedule);
    } catch {
      // 文件不存在或损坏都当作"没有定时"：这是常态，不该报错。
      return [];
    }
  }

  async save(spec: ScheduleSpec): Promise<void> {
    const all = await this.load();
    const index = all.findIndex((s) => s.id === spec.id);
    if (index >= 0) all[index] = spec;
    else all.push(spec);
    await this.write(all);
  }

  async remove(id: string): Promise<void> {
    const all = await this.load();
    await this.write(all.filter((s) => s.id !== id));
  }

  private async write(all: readonly ScheduleSpec[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  }
}

/** 容忍手工编辑造成的字段缺失，坏掉的条目直接跳过而不是整体失败。 */
function isSchedule(value: unknown): value is ScheduleSpec {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.title === 'string' &&
    typeof record.goal === 'string' &&
    (record.frequency === 'daily' || record.frequency === 'weekly') &&
    typeof record.hour === 'number'
  );
}
