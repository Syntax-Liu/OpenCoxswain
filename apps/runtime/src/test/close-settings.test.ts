/**
 * 关闭行为设置测试。
 *
 * 核心规则：**选「退出」且有 Agent 在跑时，必须提示用户**。
 * 否则用户以为只是关个窗口，实际把正在改代码的 Agent 全杀了。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  DEFAULT_CLOSE_SETTINGS,
  CloseSettingsStore,
  MemoryCloseSettings,
  shouldConfirmQuit,
} from '../settings/close.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-close-'));
  temps.push(d);
  return d;
}

describe('关闭行为规则', () => {
  it('默认是最小化到托盘', () => {
    assert.equal(DEFAULT_CLOSE_SETTINGS.closeAction, 'tray');
  });

  it('托盘模式：任何时候都不需要确认', () => {
    assert.equal(shouldConfirmQuit('tray', 0).confirm, false);
    assert.equal(shouldConfirmQuit('tray', 5).confirm, false);
  });

  it('**退出模式 + 没有 Agent → 直接退出，不打扰用户**', () => {
    assert.equal(shouldConfirmQuit('quit', 0).confirm, false);
  });

  it('**退出模式 + 有 Agent → 必须确认**', () => {
    const verdict = shouldConfirmQuit('quit', 2);
    assert.equal(verdict.confirm, true);
    assert.match(verdict.message, /2 个 Agent/);
    assert.match(verdict.message, /中断/);
  });
});

describe('关闭设置持久化', () => {
  it('存进 JSON 再读回来', async () => {
    const file = path.join(await tmp(), 'close.json');
    const store = new CloseSettingsStore(file);
    await store.save({ closeAction: 'quit' });
    assert.equal((await store.load()).closeAction, 'quit');
  });

  it('文件不存在时用默认值（不抛异常）', async () => {
    const store = new CloseSettingsStore(path.join(await tmp(), 'nope.json'));
    assert.equal((await store.load()).closeAction, 'tray');
  });

  it('坏数据也退回默认值', async () => {
    const file = path.join(await tmp(), 'bad.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{"closeAction":"乱写"}', 'utf8');
    const store = new CloseSettingsStore(file);
    assert.equal((await store.load()).closeAction, 'tray');
  });
});

describe('端到端：checkClose 用的是真实 Agent 数', () => {
  it('**有 Agent 在跑时，退出模式会要求确认**', async () => {
    const store = new MemoryStore();
    const closeSettings = new MemoryCloseSettings();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })), closeSettings });
    const { project } = await runtime.openProject({ rootPath: await tmp() });

    // 造一个正在跑的 Agent
    await store.putExecutor({
      id: 'exe_running',
      projectId: project.id,
      sessionId: 'd1',
      label: '跑着的 Agent',
      goal: 'g',
      access: 'readwrite',
      writeScope: ['src'],
      status: 'running',
      summary: null,
      blockedReason: null,
      metrics: { turns: 0, steps: 0, tokensIn: 0, tokensOut: 0, cachedTokens: null, durationMs: 0, contextTokens: null },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: null,
    });

    await runtime.setCloseSettings({ closeAction: 'quit' });
    const check = await runtime.checkClose();
    assert.equal(check.action, 'quit');
    assert.equal(check.running, 1);
    assert.equal(check.confirm, true, '有 Agent 在跑，必须确认');

    await runtime.dispose();
  });

  it('没有 Agent 时退出不确认', async () => {
    const store = new MemoryStore();
    const closeSettings = new MemoryCloseSettings();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })), closeSettings });
    await runtime.openProject({ rootPath: await tmp() });

    await runtime.setCloseSettings({ closeAction: 'quit' });
    const check = await runtime.checkClose();
    assert.equal(check.running, 0);
    assert.equal(check.confirm, false);

    await runtime.dispose();
  });

  it('托盘模式即使有 Agent 也不确认', async () => {
    const store = new MemoryStore();
    const closeSettings = new MemoryCloseSettings();
    const runtime = new Orchestrator({ store, llm: new MockLlmClient(() => ({ text: 'ok' })), closeSettings });
    const { project } = await runtime.openProject({ rootPath: await tmp() });

    await store.putExecutor({
      id: 'e1',
      projectId: project.id,
      sessionId: 'd1',
      label: 'x',
      goal: 'g',
      access: 'readwrite',
      writeScope: ['src'],
      status: 'running',
      summary: null,
      blockedReason: null,
      metrics: { turns: 0, steps: 0, tokensIn: 0, tokensOut: 0, cachedTokens: null, durationMs: 0, contextTokens: null },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: Date.now(),
      endedAt: null,
    });

    await runtime.setCloseSettings({ closeAction: 'tray' });
    const check = await runtime.checkClose();
    assert.equal(check.confirm, false, '托盘模式不杀 Agent，不需要确认');

    await runtime.dispose();
  });
});
