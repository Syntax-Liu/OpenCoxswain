import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeRuntimeAdapter, PidLedger, processImage } from '@opencoxswain/adapters';
import { delay } from './helpers.js';

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await processImage(pid)) === null) return true;
    await delay(100);
  }
  return (await processImage(pid)) === null;
}

function spawnLoop(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  return new Promise((resolve, reject) => {
    child.on('spawn', () => resolve(child.pid ?? 0));
    child.on('error', reject);
  });
}

async function tempLedger(t: { after: (fn: () => Promise<void>) => void }): Promise<{
  dir: string;
  ledger: PidLedger;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-pids-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, ledger: new PidLedger(dir) };
}

test('reap 结束遗留进程并删除台账', async (t) => {
  const { dir, ledger } = await tempLedger(t);
  const pid = await spawnLoop();
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已被 reap 结束。
    }
  });
  await ledger.track(pid, {
    image: path.basename(process.execPath),
    taskId: 'tsk_pid',
    worktree: dir,
    startedAt: Date.now(),
  });
  const records = await ledger.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.pid, pid);
  assert.equal(records[0]?.taskId, 'tsk_pid');

  const result = await ledger.reap();
  assert.deepEqual(result, { killed: [pid], stale: [] });
  assert.equal(await exists(path.join(dir, `${pid}.json`)), false);
  assert.equal(await waitGone(pid), true, `进程 ${pid} 未被回收`);
});

test('空台账 reap 返回空结果', async (t) => {
  const { ledger } = await tempLedger(t);
  assert.deepEqual(await ledger.list(), []);
  assert.deepEqual(await ledger.reap(), { killed: [], stale: [] });
});

test('进程已退出时只删除台账', async (t) => {
  const { dir, ledger } = await tempLedger(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = await new Promise<number>((resolve, reject) => {
    child.on('spawn', () => resolve(child.pid ?? 0));
    child.on('error', reject);
  });
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
  await ledger.track(pid, {
    image: path.basename(process.execPath),
    startedAt: Date.now(),
  });

  const result = await ledger.reap();
  assert.deepEqual(result, { killed: [], stale: [pid] });
  assert.equal(await exists(path.join(dir, `${pid}.json`)), false);
});

test('进程名不符时不杀进程，只清台账', async (t) => {
  const { dir, ledger } = await tempLedger(t);
  const pid = await spawnLoop();
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出。
    }
  });
  await ledger.track(pid, {
    image: 'definitely-not-this-process.exe',
    startedAt: Date.now(),
  });

  const result = await ledger.reap();
  assert.deepEqual(result, { killed: [], stale: [pid] });
  assert.notEqual(await processImage(pid), null, `进程 ${pid} 不应被误杀`);
  assert.equal(await exists(path.join(dir, `${pid}.json`)), false);
});

test('未配置台账目录的适配器 reap 返回空', async () => {
  const adapter = new OpenCodeRuntimeAdapter();
  assert.deepEqual(await adapter.reapOrphans(), { killed: [], stale: [] });
});
