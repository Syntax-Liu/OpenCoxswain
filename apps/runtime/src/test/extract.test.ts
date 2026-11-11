/**
 * 记忆自动提炼测试。
 *
 * 核心风险：自动记忆会把**错误的东西**沉淀成"正确的做法"。
 * 所以三条硬规则都要测：
 * 1. 提炼出的是候选，不直接生效；
 * 2. 候选同样过写入门槛（临时指令/模糊偏好/密钥进不来）；
 * 3. 用户拒绝过的内容不再提出。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { extractCandidates, parseCandidates } from '../memory/extract.js';
import { MarkdownMemoryStore } from '../memory/store.js';
import { Orchestrator } from '../orchestrator.js';
import { MemoryStore } from '../store/store.js';
import { MockLlmClient } from './mock-llm.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ocx-memo-'));
  temps.push(d);
  return d;
}

/** 一个只会按脚本返回 JSON 的假模型。 */
function jsonLlm(json: string): MockLlmClient {
  return new MockLlmClient(() => ({ text: json }));
}

const noop = new AbortController().signal;

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

describe('候选解析', () => {
  it('解析合法 JSON 数组', () => {
    const list = parseCandidates(
      '[{"kind":"profile","scope":"global","text":"用 pnpm"},{"kind":"project","scope":"project","text":"接口要鉴权"}]',
    );
    assert.equal(list.length, 2);
    assert.equal(list[0]?.kind, 'profile');
    assert.equal(list[0]?.scope, 'global');
  });

  it('容忍模型包了一层 markdown 代码块', () => {
    const list = parseCandidates('```json\n[{"kind":"lesson","scope":"project","text":"用 powershell -Command"}]\n```');
    assert.equal(list.length, 1);
  });

  it('非法 JSON 返回空（不抛异常）', () => {
    assert.deepEqual(parseCandidates('完全不是 JSON'), []);
    assert.deepEqual(parseCandidates(''), []);
  });

  it('过滤非法 kind', () => {
    const list = parseCandidates('[{"kind":"随便","text":"x"}]');
    assert.equal(list.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 提炼（含门槛）
// ---------------------------------------------------------------------------

describe('提炼与写入门槛', () => {
  const transcript = [
    { role: 'user', content: '以后都用 pnpm，不要用 npm' },
    { role: 'assistant', content: '好的，记下了。' },
  ];

  it('正常内容成为候选', async () => {
    const llm = jsonLlm('[{"kind":"profile","scope":"global","text":"用户偏好使用 pnpm 而不是 npm"}]');
    const result = await extractCandidates({ llm, transcript, existing: [], signal: noop });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.kind, 'profile');
  });

  it('**临时指令被门槛拦下**（核心断言）', async () => {
    const llm = jsonLlm(
      '[{"kind":"project","scope":"project","text":"这次先用 axios 顶一下"},{"kind":"lesson","scope":"project","text":"Windows 上用 powershell -Command 调用 PS 命令"}]',
    );
    const result = await extractCandidates({ llm, transcript, existing: [], signal: noop });

    const texts = result.candidates.map((c) => c.text);
    assert.equal(texts.length, 1, '临时指令不该进候选');
    assert.ok(!texts.some((t) => t.includes('这次先用 axios')));
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? '', /临时指令/);
  });

  it('模糊偏好被拦下', async () => {
    const llm = jsonLlm('[{"kind":"profile","scope":"global","text":"可能以后都这样吧"}]');
    const result = await extractCandidates({ llm, transcript, existing: [], signal: noop });
    assert.equal(result.candidates.length, 0);
    assert.ok(result.rejected.length > 0);
  });

  it('疑似密钥被拦下', async () => {
    const llm = jsonLlm('[{"kind":"project","scope":"project","text":"apiKey: sk-abcdef1234567890abcdef"}]');
    const result = await extractCandidates({ llm, transcript, existing: [], signal: noop });
    assert.equal(result.candidates.length, 0);
    assert.match(result.rejected[0]?.reason ?? '', /密钥/);
  });

  it('与已有记忆重复的不提', async () => {
    const llm = jsonLlm('[{"kind":"profile","scope":"global","text":"用户偏好使用 pnpm"}]');
    const result = await extractCandidates({
      llm,
      transcript,
      existing: ['用户偏好使用 PNPM'],
      signal: noop,
    });
    assert.equal(result.candidates.length, 0);
  });

  it('用户拒绝过的内容不再提出', async () => {
    const llm = jsonLlm('[{"kind":"project","scope":"project","text":"所有接口都要加鉴权"}]');
    const result = await extractCandidates({
      llm,
      transcript,
      existing: [],
      dismissed: ['所有接口都要加鉴权'],
      signal: noop,
    });
    assert.equal(result.candidates.length, 0);
  });

  it('最多 3 条（宁缺毋滥）', async () => {
    const many = JSON.stringify(
      Array.from({ length: 8 }, (_, i) => ({
        kind: 'lesson',
        scope: 'project',
        text: `第 ${i} 条值得记住的教训内容`,
      })),
    );
    const result = await extractCandidates({ llm: jsonLlm(many), transcript, existing: [], signal: noop });
    assert.ok(result.candidates.length <= 3);
  });

  it('模型调用失败时安静返回空（不影响主流程）', async () => {
    const failing = new MockLlmClient(() => {
      throw new Error('模型挂了');
    });
    const result = await extractCandidates({ llm: failing, transcript, existing: [], signal: noop });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it('空对话不调用模型', async () => {
    let called = false;
    const llm = new MockLlmClient(() => {
      called = true;
      return { text: '[]' };
    });
    await extractCandidates({ llm, transcript: [], existing: [], signal: noop });
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// 端到端：候选不生效，采纳后才写入
// ---------------------------------------------------------------------------

describe('端到端：候选必须经用户采纳才生效', () => {
  it('提炼后记忆文件里还没有内容，采纳后才出现', async () => {
    const root = await tmp();
    const memRoot = await tmp();
    const memory = new MarkdownMemoryStore({ rootDir: memRoot });

    const store = new MemoryStore();
    const llm = jsonLlm('[{"kind":"project","scope":"project","text":"所有接口都要加鉴权"}]');
    const runtime = new Orchestrator({ store, llm, memory });
    const { project } = await runtime.openProject({ rootPath: root });

    // 先造一段对话
    await store.appendMessage(project.assistantSessionId, {
      id: 'm1',
      role: 'user',
      content: '以后所有接口都要加鉴权，这是规矩',
      source: 'webapp',
      at: Date.now(),
    });

    const result = await runtime.extractMemoryCandidates(project.id);
    assert.equal(result.created, 1);

    // **关键：候选存在，但记忆文件还是空的**
    const beforeAccept = await memory.list({ kind: 'project', projectKey: project.rootPath });
    assert.equal(beforeAccept.length, 0, '候选不能自动生效');

    const pending = store.listCandidates({ projectId: project.id, status: ['pending'] });
    assert.equal(pending.length, 1);

    // 采纳才写入
    const accepted = await runtime.acceptMemoryCandidate(pending[0]!.id);
    assert.equal(accepted.ok, true);

    const afterAccept = await memory.list({ kind: 'project', projectKey: project.rootPath });
    assert.equal(afterAccept.length, 1);
    assert.match(afterAccept[0]!.text, /加鉴权/);

    await runtime.dispose();
  });

  it('忽略后不写入，且之后不再提出', async () => {
    const root = await tmp();
    const memRoot = await tmp();
    const memory = new MarkdownMemoryStore({ rootDir: memRoot });

    const store = new MemoryStore();
    const llm = jsonLlm('[{"kind":"project","scope":"project","text":"所有接口都要加鉴权"}]');
    const runtime = new Orchestrator({ store, llm, memory });
    const { project } = await runtime.openProject({ rootPath: root });

    await store.appendMessage(project.assistantSessionId, {
      id: 'm1',
      role: 'user',
      content: '所有接口都要加鉴权',
      source: 'webapp',
      at: Date.now(),
    });

    await runtime.extractMemoryCandidates(project.id);
    const pending = store.listCandidates({ projectId: project.id, status: ['pending'] });
    const dismissed = await runtime.dismissMemoryCandidate(pending[0]!.id);
    assert.equal(dismissed.ok, true);

    // 记忆为空
    assert.equal((await memory.list({ kind: 'project', projectKey: project.rootPath })).length, 0);

    // 再提炼一次：同样的内容不再提出
    const second = await runtime.extractMemoryCandidates(project.id);
    assert.equal(second.created, 0, '拒绝过的内容不该重复提出');

    await runtime.dispose();
  });

  it('一条候选只能处理一次', async () => {
    const root = await tmp();
    const memRoot = await tmp();
    const memory = new MarkdownMemoryStore({ rootDir: memRoot });
    const store = new MemoryStore();
    const llm = jsonLlm('[{"kind":"project","scope":"project","text":"部署用 pnpm build"}]');
    const runtime = new Orchestrator({ store, llm, memory });
    const { project } = await runtime.openProject({ rootPath: root });

    await store.appendMessage(project.assistantSessionId, {
      id: 'm1',
      role: 'user',
      content: '部署用 pnpm build',
      source: 'webapp',
      at: Date.now(),
    });

    await runtime.extractMemoryCandidates(project.id);
    const id = store.listCandidates({ projectId: project.id, status: ['pending'] })[0]!.id;

    assert.equal((await runtime.acceptMemoryCandidate(id)).ok, true);
    const second = await runtime.acceptMemoryCandidate(id);
    assert.equal(second.ok, false);
    assert.match(second.message, /已是 accepted/);

    await runtime.dispose();
  });
});
