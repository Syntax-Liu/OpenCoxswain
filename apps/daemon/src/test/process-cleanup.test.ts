import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeRuntimeAdapter, killTree, runCommand } from '@opencoxswain/adapters';
import type { AcceptanceCriterion } from '@opencoxswain/shared';
import { SystemVerification } from '../verification.js';
import { delay } from './helpers.js';

/** 让被测命令再起一个长命孙进程，并把孙进程 PID 写进文件。 */
function spawnGrandchildScript(pidFile: string): string {
  return [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));`,
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n');
}

async function isAlive(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const child = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on('close', () => resolve(output.includes(`"${pid}"`)));
      child.on('error', () => resolve(false));
    });
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await isAlive(pid))) return true;
    await delay(100);
  }
  return !(await isAlive(pid));
}

async function waitForPid(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (pid > 0) return pid;
    } catch {
      // 孙进程尚未写出文件。
    }
    await delay(100);
  }
  throw new Error('等待孙进程 PID 超时');
}

test('验收命令超时后连孙进程一起清理', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-proc-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'spawn-grandchild.mjs');
  await writeFile(script, spawnGrandchildScript(pidFile), 'utf8');

  const pending = runCommand(`"${process.execPath}" "${script}"`, dir, process.env, 3000);
  const pid = await waitForPid(pidFile);
  const result = await pending;
  assert.notEqual(result.code, 0);
  assert.equal(await waitGone(pid), true, `孙进程 ${pid} 未被清理`);
});

test('系统复核的命令超时后同样清理孙进程', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-proc-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'spawn-grandchild.mjs');
  await writeFile(script, spawnGrandchildScript(pidFile), 'utf8');

  const verification = new SystemVerification({ timeoutMs: 3000 });
  const criteria: AcceptanceCriterion[] = [
    { id: 'ac_cmd', type: 'command', desc: '不应挂住', check: `"${process.execPath}" "${script}"` },
  ];
  const pending = verification.verify({
    taskId: 'tsk_proc',
    worktree: dir,
    criteria,
    artifacts: [],
  });
  const pid = await waitForPid(pidFile);
  const result = await pending;
  assert.equal(result.records[0]?.verdict, 'failed');
  assert.equal(await waitGone(pid), true, `孙进程 ${pid} 未被清理`);
});

test('killTree 结束时按进程组回收', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出。
    }
  });
  assert.ok(child.pid);
  await delay(300);
  await killTree(child, { group: true });
  assert.equal(await waitGone(child.pid!), true);
});

test('disposeAll 清空所有会话', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-proc-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const adapter = new OpenCodeRuntimeAdapter({ binPath: path.join(dir, 'missing-opencode.exe') });
  const session = await adapter.createSession({
    taskId: 'tsk_proc',
    worktree: dir,
    role: { name: 'implementer', allowedTools: [], readOnly: false, outputSchema: 'text' },
    model: { provider: 'mock', model: 'mock-fast', apiKeyRef: '', maxTokens: 1000 },
    approvalPolicy: { requireHumanFor: [] },
    env: {},
  });
  await adapter.disposeAll();
  await assert.rejects(() => adapter.collect(session), /未知会话/);
});
