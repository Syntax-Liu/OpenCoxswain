/**
 * 路径归一化的边界情况。
 *
 * 背景（真实 bug）：桌面壳曾把 `D:\` 当作项目根传进来，归一化后得到 `"d:"`。
 * Node 把 `"d:"` 解释成"D 盘的当前目录"，`path.resolve` 出来是错的，
 * Agent 的文件操作随即报 `EISDIR: lstat 'D:'`。
 *
 * 所以盘符根必须归一化成 `d:/`。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { normalizePath } from '../store/store.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe('normalizePath', () => {
  it('盘符根保留尾斜杠（回归：曾归一化成 "d:" 导致 EISDIR）', () => {
    assert.equal(normalizePath('D:\\'), 'd:/');
    assert.equal(normalizePath('D:/'), 'd:/');
    assert.equal(normalizePath('c:\\'), 'c:/');
  });

  it('普通路径去掉尾斜杠并小写', () => {
    assert.equal(normalizePath('D:\\Work\\App\\'), 'd:/work/app');
    assert.equal(normalizePath('d:/work/app'), 'd:/work/app');
  });

  it('POSIX 根保持为 "/"', () => {
    assert.equal(normalizePath('/'), '/');
    assert.equal(normalizePath('///'), '/');
  });

  it('空串归一化为 "/"，不会变成空路径', () => {
    assert.equal(normalizePath(''), '/');
  });

  it('同一目录的多种写法归一化后一致（多项目不串台的前提）', () => {
    const variants = ['D:\\work\\app', 'd:/work/app/', 'D:/WORK/APP'];
    const normalized = variants.map(normalizePath);
    assert.equal(new Set(normalized).size, 1);
  });
});

describe('盘符根路径可被 Node 正确解析', () => {
  it('"d:/" 的 resolve 结果不是 "d:"', () => {
    const resolved = path.resolve('d:/');
    assert.notEqual(resolved, 'd:');
    // 盘符根的 resolve 应当就是根目录本身（带分隔符）
    assert.match(resolved, /^d:[\\/]$/i);
  });
});

describe('Agent可以在真实临时目录工作（端到端）', () => {
  it('在临时目录下写文件成功——证明路径解析没退化', async () => {
    const { Orchestrator } = await import('../orchestrator.js');
    const { MemoryStore } = await import('../store/store.js');
    const { MockLlmClient } = await import('./mock-llm.js');
    const { readFile } = await import('node:fs/promises');

    const root = await mkdtemp(path.join(tmpdir(), 'ocx-path-'));
    temps.push(root);

    let step = 0;
    const llm = new MockLlmClient((request) => {
      const system = request.messages.find((m) => m.role === 'system');
      const isExecutor =
        typeof system?.content === 'string' && system.content.startsWith('你是Agent。');
      if (!isExecutor) return { text: 'ok' };
      step += 1;
      if (step === 1) {
        return { tool: 'write_file', args: { path: 'proof.txt', content: 'written' } };
      }
      return { text: '结论：已写入 proof.txt' };
    });

    const store = new MemoryStore();
    const runtime = new Orchestrator({ store, llm });
    const { project } = await runtime.openProject({ rootPath: root });
    await runtime.spawn(project.id, { label: '写文件', goal: '写 proof.txt' });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const e = store.listExecutors({ projectId: project.id })[0];
      if (e && (e.status === 'done' || e.status === 'failed')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const content = await readFile(path.join(root, 'proof.txt'), 'utf8');
    assert.equal(content, 'written');
    await runtime.dispose();
    await writeFile(path.join(root, 'marker'), 'x');
  });
});
