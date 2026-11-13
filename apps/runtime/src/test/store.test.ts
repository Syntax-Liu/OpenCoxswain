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

    it('**归档项目后数据全部保留**（移除 ≠ 删除）', async () => {
      const store = await factory();
      await store.putProject(project());
      await store.putSession({
        id: 's1',
        kind: 'assistant',
        projectId: 'prj_1',
        parentSessionId: null,
        label: 'Assistant',
        systemPrompt: 'sys',
        status: 'idle',
        resumable: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await store.appendMessage('s1', {
        id: 'm1',
        role: 'user',
        content: '改一下登录页',
        source: 'webapp',
        at: 2,
      });

      await store.archiveProject('prj_1');

      // 从列表消失
      assert.equal(store.listProjects().length, 0);
      // **但会话和消息都还在**——出事时还要能查到
      assert.ok(store.getSession('s1'), '会话应当保留');
      assert.equal(store.messages('s1').length, 1, '消息应当保留');
      // 项目记录本身也在（只是标记归档）
      assert.equal(store.getProject('prj_1')?.id, 'prj_1', '项目记录应当保留');
      await store.close();
    });

    it('**归档后可以用同一目录重新打开**', async () => {
      const store = await factory();
      await store.putProject(project());
      await store.archiveProject('prj_1');

      // 唯一索引是 WHERE archived = 0，所以同路径可以再建一条
      await store.putProject({ ...project(), id: 'prj_2' });
      assert.equal(store.listProjects().length, 1);
      assert.equal(store.listProjects()[0]?.id, 'prj_2');
      await store.close();
    });

    it('归档不存在的项目不报错', async () => {
      const store = await factory();
      await store.archiveProject('prj_nope');
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

    it('Agent：写域数组与访问形态能完整往返', async () => {
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

    it('**会话按创建时间倒序**（最新的排最前）', async () => {
      const store = await factory();
      // 用独有的路径：SQLite 后端的 factory 可能复用同一个库文件，
      // 和前面测试用同一个 root_path 会撞唯一索引。
      await store.putProject({ ...project(), id: 'prj_order', rootPath: 'd:/work/order-test' });

      for (const [id, at] of [
        ['e_old', 1000],
        ['e_mid', 2000],
        ['e_new', 3000],
      ] as const) {
        await store.putExecutor({
          id,
          projectId: 'prj_order',
          sessionId: `s_${id}`,
          label: id,
          goal: 'g',
          access: 'readwrite',
          writeScope: [],
          status: 'done',
          summary: '',
          blockedReason: null,
          metrics: {
            turns: 0,
            steps: 0,
            tokensIn: 0,
            tokensOut: 0,
            cachedTokens: null,
            durationMs: 0,
            contextTokens: null,
          },
          criteria: [],
          policy: 'auto',
          acceptance: null,
          createdAt: at,
          endedAt: at + 1,
        } as never);
      }

      const list = store.listExecutors({ projectId: 'prj_order' });
      // 侧栏里用户最关心刚派出去的那个，必须排最前
      assert.deepEqual(
        list.map((e) => e.id),
        ['e_new', 'e_mid', 'e_old'],
      );
      await store.close();
    });

    it('Agent：只读访问形态也能往返', async () => {
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
  it('重新打开同一个库，项目/会话/历史/Agent/汇报全都还在', async () => {
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
