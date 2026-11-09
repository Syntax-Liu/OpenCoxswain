import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '../app.js';
import { runGit } from '../git.js';

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RepoFixture {
  temp: string;
  home: string;
  repo: string;
}

export async function makeRepo(files: Record<string, string>): Promise<RepoFixture> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'opencoxswain-test-'));
  const repo = path.join(temp, 'repo');
  const home = path.join(temp, 'home');
  await mkdir(repo, { recursive: true });
  await mkdir(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(repo, name), content, 'utf8');
  }
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', 'OpenCoxswain Test']);
  await runGit(repo, ['config', 'user.email', 'test@opencoxswain.local']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', 'init']);
  return { temp, home, repo };
}

export interface DaemonFixture {
  app: Awaited<ReturnType<typeof startDaemon>>;
  call: <T>(url: string, init?: RequestInit) => Promise<T>;
}

export async function makeDaemon(home: string): Promise<DaemonFixture> {
  const app = await startDaemon({
    homeDir: home,
    dbPath: path.join(home, 'test.db'),
    worktreesDir: path.join(home, 'worktrees'),
    artifactsDir: path.join(home, 'artifacts'),
    port: 0,
  });
  const base = `http://127.0.0.1:${app.port}`;
  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${url}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status}: ${text}`);
    return JSON.parse(text) as T;
  };
  return { app, call };
}

export async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await delay(200);
  }
  throw new Error('等待条件超时');
}
