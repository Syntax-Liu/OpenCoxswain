import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createExecutorToolHost } from '../executor/executor.js';
import { MAX_SUBAGENT_DEPTH, SUBAGENT_MAX_STEPS } from '../executor/subagent.js';

/**
 * 子 Agent 的工具接线。
 *
 * ## 和 `spawn_executor` 的区别
 *
 * `spawn_executor` 是 Assistant 派**同级 Agent**（建会话、进侧栏、异步）。
 * `spawn_subagent` 是 Agent 派**子任务**（不建会话、同步等结果）。
 * 两者的边界要守住：子 Agent 不该进侧栏，也不该无限嵌套。
 */

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ocx-sub-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('spawn_subagent 的边界', () => {
  it('**没给 llm 时明确拒绝**，不假装派出', async () => {
    const host = createExecutorToolHost({ rootPath: root, writeScope: [] });
    const r = await host.execute({
      name: 'spawn_subagent',
      args: { task: '查一下某个东西' },
    });

    assert.equal(r.ok, false);
    assert.match(r.content, /不支持派子 Agent/);
    // 关键：要告诉模型自己做完，而不是静默成功
    assert.match(r.content, /自己完成/);
  });

  it('**深度到顶时拒绝**', async () => {
    const host = createExecutorToolHost({
      rootPath: root,
      writeScope: [],
      // 给一个假的 llm，让它走进 runSubagent 的深度检查
      llm: {} as never,
      subagentDepth: MAX_SUBAGENT_DEPTH,
    });
    const r = await host.execute({
      name: 'spawn_subagent',
      args: { task: '再派一层' },
    });
    assert.equal(r.ok, false);
    assert.match(r.content, /不能再派子 Agent/);
  });
});

describe('子 Agent 的常量', () => {
  it('步数有上限（防止烧光预算）', () => {
    assert.equal(SUBAGENT_MAX_STEPS, 15);
  });

  it('嵌套上限是 2 层', () => {
    assert.equal(MAX_SUBAGENT_DEPTH, 2);
  });
});

describe('工具集里两个新工具都在', () => {
  it('read_url 在', async () => {
    const host = createExecutorToolHost({ rootPath: root, writeScope: [] });
    const names = host.definitions().map((d) => d.name);
    assert.ok(names.includes('read_url'), `工具集: ${names.join(', ')}`);
  });

  it('web_search 在', async () => {
    const host = createExecutorToolHost({ rootPath: root, writeScope: [] });
    const names = host.definitions().map((d) => d.name);
    assert.ok(names.includes('web_search'));
  });

  it('spawn_subagent 在', async () => {
    const host = createExecutorToolHost({ rootPath: root, writeScope: [] });
    const names = host.definitions().map((d) => d.name);
    assert.ok(names.includes('spawn_subagent'));
  });

  it('read_url 在只读任务里也可用（它不改任何东西）', async () => {
    const host = createExecutorToolHost({ rootPath: root, writeScope: [], readonlyTask: true });
    const names = host.definitions().map((d) => d.name);
    assert.ok(names.includes('read_url'));
  });
});
