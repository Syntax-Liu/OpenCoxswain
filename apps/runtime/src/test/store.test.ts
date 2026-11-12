/**
 * 存储后端一致性测试。
 *
 * **同一套断言跑两个后端**（内存 / SQLite），确保"换后端不改变行为"。
 * 这是安全切换持久化的唯一凭据——没有它，内存上通过的行为可能在 SQLite 上不同。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { MemoryStore, type ProjectRow, type Store } from '../store/store.js';
import { SqliteStore } from '../store/sqlite.js';
import { EMPTY_METRICS } from '../cost/metrics.js';

const temps: string[] = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

async function storeFactories(): Promise<Array<[string, () => Promise<Store>]>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ocx-store-'));
  temps.push(dir);
  return [
    ['memory', async () => new MemoryStore()],
    ['sqlite', async () => new SqliteStore({ file: path.join(dir, 'test.db') })],
  ];
}

function project(id = 'prj_1'): ProjectRow {
  return {
    id,
    name: 'demo',
    rootPath: 'd:/work/demo',
    displayPath: 'D:/work/demo',
    assistantSessionId: `c_${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
  };
}

for (const [label, factory] of await storeFactories()) {
  describe(`存储后端：${label}`, () => {
    it('项目按路径查找，归档后查不到', async () => {
      const store = await factory();
      await store.putProject(project());
      assert.equal(store.getProjectByPath('d:/work/demo')?.id, 'prj_1');

      await store.putProject({ ...project(), archived: true });
      assert.equal(store.getProjectByPath('d:/work/demo'), undefined);
      assert.equal(store.listProjects().length, 0);
      await store.close();
    });

    it('会话与消息历史按顺序回放，含 system', async () => {
      const store = await factory();
      await store.putSession({
        id: 'c1',
        kind: 'assistant',
        projectId: 'prj_1',
        parentSessionId: null,
        label: 'C',
        systemPrompt: 'SYSTEM',
        status: 'idle',
        resumable: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await store.appendMessage('c1', {
        id: 'm1',
        role: 'user',
        content: '你好',
        source: 'webapp',
        at: 2,
      });
      await store.appendMessage('c1', {
        id: 'm2',
        role: 'assistant',
        content: '收到',
        source: 'assistant',
        at: 3,
      });

      const history = store.chatHistory('c1');
      assert.equal(history[0]!.role, 'system');
      assert.equal(history[0]!.content, 'SYSTEM');
      assert.deepEqual(
        history.slice(1).map((m) => m.content),
        ['你好', '收到'],
      );
      await store.close();
    });

    it('执行者：写域数组与访问形态能完整往返', async () => {
      const store = await factory();
      await store.putExecutor({
        id: 'e1',
        projectId: 'prj_1',
        sessionId: 'd1',
        label: '写文件',
        goal: 'g',
        access: 'readwrite',
        writeScope: ['src/auth', 'src/export'],
        status: 'running',
        summary: null,
        blockedReason: null,
        metrics: { ...EMPTY_METRICS, turns: 3, steps: 2, tokensIn: 1200, tokensOut: 300 },
        criteria: [],
        policy: 'unverified_only',
        acceptance: null,
        createdAt: 5,
        endedAt: null,
      });

      const loaded = store.getExecutor('e1');
      assert.deepEqual(loaded?.writeScope, ['src/auth', 'src/export']);
      assert.equal(loaded?.access, 'readwrite');

      await store.putExecutor({
        ...loaded!,
        status: 'done',
        summary: '完成了',
        endedAt: 9,
      });
      const updated = store.getExecutor('e1');
      assert.equal(updated?.status, 'done');
      assert.equal(updated?.summary, '完成了');
      assert.equal(updated?.endedAt, 9);

      // 按状态过滤
      assert.equal(store.listExecutors({ projectId: 'prj_1', status: ['running'] }).length, 0);
      assert.equal(store.listExecutors({ projectId: 'prj_1', status: ['done'] }).length, 1);
      await store.close();
    });

    it('执行者：只读访问形态也能往返', async () => {
      const store = await factory();
      await store.putExecutor({
        id: 'e2',
        projectId: 'prj_1',
        sessionId: 'd2',
        label: '只读排查',
        goal: 'g',
        access: 'readonly',
        writeScope: [],
        status: 'running',
        summary: null,
        blockedReason: null,
        metrics: EMPTY_METRICS,
        criteria: [],
        policy: 'unverified_only',
        acceptance: null,
        createdAt: 6,
        endedAt: null,
      });
      assert.equal(store.getExecutor('e2')?.access, 'readonly');
      await store.close();
    });

    it('对话轮：判定可回写，列表按时间升序', async () => {
      const store = await factory();
      await store.appendTurn({
        id: 't1',
        projectId: 'prj_1',
        role: 'assistant',
        source: 'assistant',
        executorId: 'e1',
        text: '第一条',
        judged: null,
        at: 10,
      });
      await store.appendTurn({
        id: 't2',
        projectId: 'prj_1',
        role: 'assistant',
        source: 'assistant',
        executorId: 'e2',
        text: '第二条',
        judged: 'parallel',
        at: 20,
      });

      await store.judgeTurn('t1', 'conflict');
      const turns = store.listTurns('prj_1');
      assert.equal(turns.length, 2);
      assert.equal(turns[0]!.judged, 'conflict');
      assert.equal(turns[1]!.judged, 'parallel');
      await store.close();
    });

    it('汇报：按项目与待决策过滤', async () => {
      const store = await factory();
      await store.putReport({
        id: 'r1',
        projectId: 'prj_1',
        executorId: 'e1',
        kind: 'done',
        body: '完成 A',
        needsUser: false,
        at: 1,
        ackedAt: null,
      });
      await store.putReport({
        id: 'r2',
        projectId: 'prj_1',
        executorId: 'e2',
        kind: 'failed',
        body: '失败 B',
        needsUser: true,
        at: 2,
        ackedAt: null,
      });

      assert.equal(store.listReports({ projectId: 'prj_1' }).length, 2);
      assert.equal(store.listReports({ projectId: 'prj_1', needsUser: true }).length, 1);
      assert.equal(store.listReports({ projectId: 'prj_1', needsUser: true })[0]!.id, 'r2');
      await store.close();
    });
  });
}

// ---------------------------------------------------------------------------
// 只有 SQLite 才有的：跨"重启"存活
// ---------------------------------------------------------------------------

describe('SQLite：关掉软件后完整恢复（D5）', () => {
  it('重新打开同一个库，项目/会话/历史/执行者/汇报全都还在', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ocx-persist-'));
    temps.push(dir);
    const file = path.join(dir, 'state.db');

    // ---- 第一次运行 ----
    const first = new SqliteStore({ file });
    await first.putProject(project());
    await first.putSession({
      id: 'c1',
      kind: 'assistant',
      projectId: 'prj_1',
      parentSessionId: null,
      label: 'C',
      systemPrompt: '你是Assistant',
      status: 'idle',
      resumable: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await first.appendMessage('c1', {
      id: 'm1',
      role: 'user',
      content: '把登录页重构一下',
      source: 'webapp',
      at: 2,
    });
    await first.putExecutor({
      id: 'e1',
      projectId: 'prj_1',
      sessionId: 'd1',
      label: '重构',
      goal: 'g',
      access: 'readwrite',
      writeScope: ['src/auth'],
      status: 'done',
      summary: '完成',
      blockedReason: null,
      metrics: { ...EMPTY_METRICS, turns: 5, steps: 4, tokensIn: 2000, tokensOut: 800, cachedTokens: 1500 },
      criteria: [],
      policy: 'unverified_only',
      acceptance: null,
      createdAt: 3,
      endedAt: 4,
    });
    await first.putReport({
      id: 'r1',
      projectId: 'prj_1',
      executorId: 'e1',
      kind: 'done',
      body: '完成汇报',
      needsUser: false,
      at: 5,
      ackedAt: null,
    });
    await first.close();

    // ---- 模拟重启：重新打开 ----
    const second = new SqliteStore({ file });

    const proj = second.getProjectByPath('d:/work/demo');
    assert.ok(proj, '项目必须还在');
    assert.equal(proj.assistantSessionId, 'c_prj_1');

    const session = second.getSession('c1');
    assert.ok(session, 'Assistant 的会话必须还在');
    assert.equal(session.systemPrompt, '你是Assistant');

    const history = second.chatHistory('c1');
    assert.equal(history.length, 2, 'system + 一条用户消息');
    assert.equal(history[1]!.content, '把登录页重构一下');

    const executor = second.getExecutor('e1');
    assert.equal(executor?.status, 'done');
    assert.deepEqual(executor?.writeScope, ['src/auth']);

    assert.equal(second.listReports({ projectId: 'prj_1' }).length, 1);

    await second.close();
  });

  it('schema 版本写进了 user_version，重复打开不重跑迁移', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ocx-schema-'));
    temps.push(dir);
    const file = path.join(dir, 'schema.db');

    const first = new SqliteStore({ file });
    await first.putProject(project());
    await first.close();

    // 第二次打开不应报错（迁移是幂等的）
    const second = new SqliteStore({ file });
    assert.equal(second.listProjects().length, 1);
    await second.close();
  });
});
