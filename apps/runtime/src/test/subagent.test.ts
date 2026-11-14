import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

describe('**执行链路真的接通了**', () => {
  // 这个坑踩过：工具定义写了、执行分支写了，但 runExecutor 建 toolHost
  // 时没把 llm / signal 传下去——真实运行里永远走"没给 llm → 拒绝"。
  // 单测里的 mock 看不出这个问题，所以要读源码断言。
  //
  // 注意：测试跑的是 dist/，要读**源码**才能看到这些传参。
  const source = readFileSync(
    new URL('../../src/executor/executor.ts', import.meta.url),
    'utf8',
  );

  it('runExecutor 建 toolHost 时传了 llm 和 signal', () => {
    const idx = source.indexOf('export async function runExecutor');
    assert.ok(idx > 0, '找不到 runExecutor');
    const block = source.slice(idx, idx + 5000);

    assert.match(block, /llm:\s*options\.llm/, 'runExecutor 没把 llm 传进 toolHost');
    assert.match(block, /signal:\s*options\.signal/, '没传 signal，父 Agent 停了子 Agent 还在跑');
    assert.match(block, /subagentDepth:\s*0/, '父 Agent 应该从深度 0 开始');
  });

  it('runExecutor 也传了 search 配置', () => {
    const idx = source.indexOf('export async function runExecutor');
    const block = source.slice(idx, idx + 5000);
    assert.match(block, /options\.search/, '没传 search，web_search 永远是"不可用"');
  });

  it('runner 把 search 传给 runExecutor', () => {
    const runner = readFileSync(
      new URL('../../src/executor/runner.ts', import.meta.url),
      'utf8',
    );
    assert.match(runner, /deps\.search/, 'runner 没把 search 传下去');
  });
});

describe('工具集里两个新工具都在', () => {  it('read_url 在', async () => {
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
