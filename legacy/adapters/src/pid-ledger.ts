import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { killPidTree } from './tooling.js';

export interface PidRecord {
  pid: number;
  /** 进程可执行文件名；PID 被系统复用时可据此识别，避免误杀无关进程。 */
  image: string;
  taskId?: string;
  worktree?: string;
  /** 启动时间戳（毫秒）。 */
  startedAt: number;
}

export interface ReapResult {
  /** 已按进程树强杀的遗留进程。 */
  killed: number[];
  /** 进程已退出或 PID 已被复用，只清掉了台账记录。 */
  stale: number[];
}

function normalizeImage(value: string): string {
  return path.basename(value.trim()).toLowerCase().replace(/\.exe$/, '');
}

function collectStdout(child: ReturnType<typeof spawn>, done: (output: string) => void): void {
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on('error', () => done(output));
  child.on('close', () => done(output));
}

/** 读取进程可执行文件名；进程不存在或查询失败时返回 null。 */
export function processImage(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        : spawn('ps', ['-p', String(pid), '-o', 'comm='], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
    collectStdout(child, (output) => {
      if (process.platform === 'win32') {
        const match = /^"([^"]+)","(\d+)"/m.exec(output);
        resolve(match && Number(match[2]) === pid ? (match[1] ?? null) : null);
        return;
      }
      const name = output.trim().split(/\r?\n/)[0]?.trim() ?? '';
      resolve(name === '' ? null : name);
    });
  });
}

/**
 * PID 台账：把已启动的运行时进程写到 `<dir>/<pid>.json`。
 *
 * daemon 被任务管理器强制结束时来不及跑卸载流程，下次启动即可按台账
 * 回收仍然存活、且进程名对得上的遗留进程树。
 */
export class PidLedger {
  constructor(private readonly dir: string) {}

  private file(pid: number): string {
    return path.join(this.dir, `${pid}.json`);
  }

  /** 记录进程；台账只是尽力而为的旁路信息，写失败不影响任务执行。 */
  async track(pid: number, info: Omit<PidRecord, 'pid'>): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(pid), `${JSON.stringify({ pid, ...info }, null, 2)}\n`, 'utf8');
    } catch {
      // 磁盘异常时放弃记账。
    }
  }

  async release(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      await rm(this.file(pid), { force: true });
    } catch {
      // 记录已不存在。
    }
  }

  async list(): Promise<PidRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: PidRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const target = path.join(this.dir, entry);
      try {
        const parsed = JSON.parse(await readFile(target, 'utf8')) as PidRecord;
        if (Number.isInteger(parsed.pid) && parsed.pid > 0 && typeof parsed.image === 'string') {
          records.push(parsed);
        } else {
          await rm(target, { force: true }).catch(() => undefined);
        }
      } catch {
        await rm(target, { force: true }).catch(() => undefined);
      }
    }
    return records;
  }

  /** 回收台账里的遗留进程：进程名匹配才强杀进程树，否则只清记录。 */
  async reap(): Promise<ReapResult> {
    const result: ReapResult = { killed: [], stale: [] };
    for (const record of await this.list()) {
      const actual = await processImage(record.pid);
      if (actual && normalizeImage(actual) === normalizeImage(record.image)) {
        await killPidTree(record.pid);
        result.killed.push(record.pid);
      } else {
        result.stale.push(record.pid);
      }
      await this.release(record.pid);
    }
    return result;
  }
}
