/**
 * 扩展口测试。
 *
 * 重点验证三件事：
 * 1. 扩展能**真的否决**工具调用（而不只是被调用）；
 * 2. 扩展**出错不影响主流程**（geek 写错一个分号不该让软件挂掉）；
 * 3. 扩展**不能**绕过审批与验收（安全边界）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { collectVeto, loadExtensions, notifyAfterTool } from '../extensions/index.js';
import { createExecutorToolHost } from '../executor/executor.js';
import { MemoryStore } from '../store/store.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function extDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-ext-'));
  temps.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('扩展加载', () => {
  it('目录不存在时安静返回空（绝大多数用户没有扩展）', async () => {
    const result = await loadExtensions(path.join(tmpdir(), 'ocx-nonexistent-dir-xyz'));
    assert.equal(result.names.length, 0);
    assert.equal(result.problems.length, 0);
  });

  it('加载一个合法扩展', async () => {
    const dir = await extDir({
      'a.mjs': 'export default function (api) { api.beforeTool(() => undefined); }',
    });
    const result = await loadExtensions(dir);
    assert.deepEqual(result.names, ['a.mjs']);
    assert.equal(result.beforeTool.length, 1);
    assert.equal(result.problems.length, 0);
  });

  it('**扩展写错语法不影响加载其它扩展**', async () => {
    const dir = await extDir({
      'bad.mjs': 'export default function ( { {{ 语法错误',
      'good.mjs': 'export default function (api) { api.beforeTool(() => undefined); }',
    });
    const result = await loadExtensions(dir);
    assert.deepEqual(result.names, ['good.mjs'], '好的扩展仍应加载');
    assert.equal(result.problems.length, 1, '坏的应记进 problems');
    assert.match(result.problems[0] ?? '', /bad\.mjs/);
  });

  it('没有 default 导出的被跳过并记录', async () => {
    const dir = await extDir({ 'x.mjs': 'export const foo = 1;' });
    const result = await loadExtensions(dir);
    assert.equal(result.names.length, 0);
    assert.match(result.problems[0] ?? '', /default/);
  });

  it('**同一个扩展注册多个 beforeTool 时累加，不互相覆盖**', async () => {
    // 回归：早期实现用单槽存储，第二个 beforeTool 覆盖第一个，
    // 导致示例里的"本机策略"静默失效。
    const dir = await extDir({
      'multi.mjs': `export default function (api) {
        api.beforeTool(({ tool }) => (tool === 'run_command' ? { veto: true, reason: '第一个' } : undefined));
        api.beforeTool(() => { /* 第二个只观察 */ });
      }`,
    });
    const result = await loadExtensions(dir);
    assert.equal(result.beforeTool.length, 2, '两个都应该被注册');
    const veto = collectVeto(result, 'run_command', { command: 'ls' });
    assert.equal(veto?.reason, '第一个', '第一个否决仍然生效');
  });
});

describe('否决', () => {
  it('扩展可以否决', async () => {
    const dir = await extDir({
      'a.mjs': `export default function (api) {
        api.beforeTool(({ tool }) => (tool === 'run_command' ? { veto: true, reason: '禁' } : undefined));
      }`,
    });
    const hooks = await loadExtensions(dir);
    const veto = collectVeto(hooks, 'run_command', { command: 'ls' });
    assert.equal(veto?.veto, true);
    assert.equal(veto?.reason, '禁');
  });

  it('不相关的调用不否决', async () => {
    const dir = await extDir({
      'a.mjs': `export default function (api) {
        api.beforeTool(({ tool }) => (tool === 'run_command' ? { veto: true, reason: '禁' } : undefined));
      }`,
    });
    const hooks = await loadExtensions(dir);
    assert.equal(collectVeto(hooks, 'read_file', { path: 'x' }), null);
  });

  it('**扩展自己抛异常时视为不否决**（不能拖垮执行）', async () => {
    const dir = await extDir({
      'a.mjs': `export default function (api) {
        api.beforeTool(() => { throw new Error('扩展内部炸了'); });
      }`,
    });
    const hooks = await loadExtensions(dir);
    assert.equal(collectVeto(hooks, 'read_file', {}), null);
  });
});

describe('端到端：扩展真的拦住工具', () => {
  it('被否决的命令不会执行', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocx-extrun-'));
    temps.push(root);

    const host = createExecutorToolHost({
      rootPath: root,
      writeScope: [],
      extensions: {
        beforeTool: [
          ({ tool, args }) =>
            tool === 'run_command' && String(args.command).includes('rm')
              ? { veto: true, reason: '本机策略禁止删除' }
              : undefined,
        ],
        afterTool: [],
      },
    });

    const result = await host.execute({
      name: 'run_command',
      args: { command: 'rm -rf something' },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /被本机扩展拦截/);
    assert.match(result.content, /本机策略禁止删除/);
  });

  it('未被否决的正常通过', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocx-extok-'));
    temps.push(root);

    let afterCalled = false;
    const host = createExecutorToolHost({
      rootPath: root,
      writeScope: [],
      extensions: {
        beforeTool: [() => undefined],
        afterTool: [
          ({ tool, ok }) => {
            afterCalled = true;
            assert.equal(tool, 'list_dir');
            assert.equal(ok, true);
          },
        ],
      },
    });

    const result = await host.execute({ name: 'list_dir', args: { path: '.' } });
    assert.equal(result.ok, true);
    assert.equal(afterCalled, true, 'afterTool 应被调用');
  });
});

describe('安全边界：扩展不能绕过核心机制', () => {
  it('扩展看不到也改不了写域（工具层仍会拒绝越界写入）', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocx-extscope-'));
    temps.push(root);

    const host = createExecutorToolHost({
      rootPath: root,
      writeScope: ['allowed'],
      // 扩展说"没问题"也没用：写域检查独立生效。
      extensions: { beforeTool: [() => undefined], afterTool: [] },
    });

    const result = await host.execute({
      name: 'write_file',
      args: { path: 'outside/x.txt', content: 'hi' },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /写域越界/);
  });

  it('只读任务即使扩展放行也写不进去', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ocx-extro-'));
    temps.push(root);

    const host = createExecutorToolHost({
      rootPath: root,
      writeScope: [],
      readonlyTask: true,
      extensions: { beforeTool: [() => undefined], afterTool: [] },
    });

    const result = await host.execute({
      name: 'write_file',
      args: { path: 'x.txt', content: 'hi' },
    });
    assert.equal(result.ok, false);
  });
});

describe('afterTool 通知', () => {
  it('多个扩展都会被通知，出错的被跳过', async () => {
    const store = new MemoryStore();
    void store;
    const seen: string[] = [];
    const hooks = {
      beforeTool: [],
      afterTool: [
        () => {
          throw new Error('炸');
        },
        (input: { tool: string }) => {
          seen.push(input.tool);
        },
      ],
      problems: [],
      names: [],
    };
    notifyAfterTool(hooks, { tool: 'list_dir', args: {}, ok: true });
    assert.deepEqual(seen, ['list_dir']);
  });
});
