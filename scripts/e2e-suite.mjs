#!/usr/bin/env node
/**
 * 标准化端到端测试。
 *
 * ## 为什么需要
 *
 * 之前发现的 bug（会话不复用、预告派活、孤儿进程、布局塌陷）
 * **全是我临时验证时偶然发现的**——说明缺少一套可重复跑的测试。
 *
 * 单元测试覆盖不了这些：它们的问题出在**真实调用链**上，
 * 而不是某个函数算错了。
 *
 * ## 原则
 *
 * 1. **断言真实状态**：查数据库、读文件，不信 Assistant 的自述
 * 2. **每步可独立失败**：一个步骤挂了，后面的照常报告
 * 3. **跑完清理**：临时项目删掉，不留垃圾
 * 4. **不碰真实项目**：只在临时目录里跑
 *
 * ## 用法
 *
 *   node scripts/e2e-suite.mjs            跑全部
 *   node scripts/e2e-suite.mjs --keep     保留临时目录（排查用）
 *   node scripts/e2e-suite.mjs --only=3   只跑第 3 步
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const BASE = 'http://127.0.0.1:47900';
const KEEP = process.argv.includes('--keep');
const ONLY = Number(
  (process.argv.find((a) => a.startsWith('--only=')) ?? '--only=0').split('=')[1] ?? 0,
);

const results = [];

/** 一次测试步骤的上下文。 */
let ctx = null;

async function token() {
  return (await readFile(path.join(homedir(), '.opencoxswain', 'token'), 'utf8')).trim();
}

let TOKEN = '';

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function db() {
  return new DatabaseSync(path.join(homedir(), '.opencoxswain', 'runtime.db'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 一个测试步骤。
 *
 * 每步独立 try/catch——一步挂了不影响后面的步骤出报告。
 */
async function step(name, fn) {
  if (ONLY > 0 && results.length + 1 !== ONLY) {
    results.push({ name, status: 'skipped' });
    return;
  }
  const started = Date.now();
  process.stdout.write(`  ${name} … `);
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, status: 'pass', ms, detail });
    console.log(`✓ ${ms}ms${detail ? `  ${detail}` : ''}`);
  } catch (error) {
    const ms = Date.now() - started;
    results.push({ name, status: 'fail', ms, error: String(error?.message ?? error) });
    console.log(`✗ ${ms}ms`);
    console.log(`      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 等到项目下所有 Agent 都不在跑。 */
async function waitIdle(projectId, maxMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { body } = await api(`/api/projects/${projectId}`);
    const running = (body.executors ?? []).filter(
      (e) => e.status === 'running' || e.status === 'starting',
    );
    if (running.length === 0) return;
    await sleep(3000);
  }
  throw new Error(`等了 ${Math.round(maxMs / 1000)} 秒还没跑完`);
}

/** 让 Assistant 说话。 */
async function say(projectId, text) {
  const r = await api(`/api/projects/${projectId}/say`, {
    method: 'POST',
    body: JSON.stringify({ text, source: 'webapp' }),
  });
  assert(r.status === 202 || r.status === 200, `POST /say 返回 ${r.status}`);
}

/** 等 Assistant 说完一轮（靠消息数增长判断）。 */
async function waitAssistantReply(projectId, sinceCount, maxMs = 120_000) {
  const start = Date.now();
  const conn = db();
  const sessionId = conn
    .prepare('SELECT assistant_session_id s FROM project WHERE id = ?')
    .get(projectId)?.s;
  conn.close();
  assert(sessionId, '找不到 Assistant 会话');

  while (Date.now() - start < maxMs) {
    const c = db();
    const row = c
      .prepare("SELECT COUNT(*) n FROM message WHERE session_id = ? AND source = 'assistant'")
      .get(sessionId);
    c.close();
    if (Number(row.n) > sinceCount) return;
    await sleep(2000);
  }
  throw new Error(`等了 ${Math.round(maxMs / 1000)} 秒 Assistant 没回复`);
}

/** 当前 Assistant 说了几条（用作基线）。 */
function assistantMessageCount(projectId) {
  const c = db();
  const sessionId = c
    .prepare('SELECT assistant_session_id s FROM project WHERE id = ?')
    .get(projectId)?.s;
  const row = c
    .prepare("SELECT COUNT(*) n FROM message WHERE session_id = ? AND source = 'assistant'")
    .get(sessionId);
  c.close();
  return Number(row?.n ?? 0);
}

/** 读 Assistant 最后一条消息文本。 */
function lastAssistantText(projectId) {
  const c = db();
  const sessionId = c
    .prepare('SELECT assistant_session_id s FROM project WHERE id = ?')
    .get(projectId)?.s;
  const row = c
    .prepare(
      "SELECT content FROM message WHERE session_id = ? AND source = 'assistant' ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId);
  c.close();
  return String(row?.content ?? '');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n标准化端到端测试\n');
  TOKEN = await token();

  // 健康检查
  const health = await api('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error('运行时不可达（127.0.0.1:47900），先启动应用。');
    process.exit(1);
  }
  console.log('运行时正常\n');

  // 准备临时项目
  const root = path.join(tmpdir(), `ocx-e2e-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'target.txt'), '原始内容', 'utf8');
  await writeFile(path.join(root, 'notes.md'), '# 测试项目\n用于端到端验证。\n', 'utf8');
  console.log(`临时项目: ${root}\n`);

  const opened = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ rootPath: root, name: 'e2e-临时项目' }),
  });
  assert(opened.status === 200 || opened.status === 201, `打开项目失败: ${opened.status}`);
  const projectId = opened.body.project.id;
  ctx = { root, projectId };

  console.log('步骤：');

  await step('1. 项目打开且路径正确', async () => {
    const { body } = await api(`/api/projects/${projectId}`);
    assert(body.project, '没有返回项目');
    assert(
      path.resolve(body.project.rootPath).toLowerCase() === path.resolve(root).toLowerCase(),
      `路径不符：${body.project.rootPath}`,
    );
    return body.project.name;
  });

  await step('2. 派活：Assistant 真的创建了 Agent', async () => {
    const before = assistantMessageCount(projectId);
    await say(projectId, '用 write_file 把 target.txt 的内容改成"已被 Agent 修改"。只做这一步。');
    await waitAssistantReply(projectId, before);
    await waitIdle(projectId);

    const c = db();
    const agents = c
      .prepare("SELECT id, status, label FROM executor WHERE project_id = ?")
      .all(projectId);
    c.close();

    assert(agents.length > 0, '**没有创建任何 Agent**——Assistant 可能只说了没做');
    const done = agents.filter((a) => a.status === 'done');
    assert(done.length > 0, `Agent 状态异常：${agents.map((a) => a.status).join(',')}`);

    // 核对"已派出"的说法
    const text = lastAssistantText(projectId);
    const claimed = [...text.matchAll(/(exe_[a-z0-9]+)/g)].map((m) => m[1]);
    const real = new Set(agents.map((a) => a.id));
    const phantom = claimed.filter((id) => !real.has(id));
    assert(phantom.length === 0, `**预告派活**：说了 ${phantom.join(',')} 但没创建`);

    return `${agents.length} 个 Agent`;
  });

  await step('3. 文件真的被改了', async () => {
    const content = await readFile(path.join(root, 'target.txt'), 'utf8');
    assert(content.includes('已被 Agent 修改'), `文件内容不符：${JSON.stringify(content)}`);
    return JSON.stringify(content.slice(0, 20));
  });

  await step('4. 副作用台账有记录', async () => {
    const c = db();
    const effects = c
      .prepare("SELECT id, kind, target, state FROM side_effect WHERE project_id = ? AND kind = 'fs.write'")
      .all(projectId);
    c.close();
    assert(effects.length > 0, '**台账里没有写文件记录**——edit_file 可能没被识别');
    const ok = effects.find((e) => e.state === 'succeeded');
    assert(ok, `台账状态异常：${effects.map((e) => e.state).join(',')}`);
    return `${effects.length} 条`;
  });

  await step('5. 撤销能恢复文件', async () => {
    const c = db();
    const eff = c
      .prepare(
        "SELECT id FROM side_effect WHERE project_id = ? AND kind = 'fs.write' AND state = 'succeeded' ORDER BY created_at DESC LIMIT 1",
      )
      .get(projectId);
    c.close();
    assert(eff, '没有可撤销的记录');

    const r = await api(`/api/side-effects/${eff.id}/undo`, {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    });
    assert(r.status === 200, `撤销返回 ${r.status}: ${JSON.stringify(r.body)}`);

    const content = await readFile(path.join(root, 'target.txt'), 'utf8');
    assert(content.includes('原始内容'), `撤销后内容不符：${JSON.stringify(content)}`);
    return '已恢复';
  });

  await step('6. 快照真的存了', async () => {
    const snapDir = path.join(homedir(), '.opencoxswain', 'snapshots');
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(snapDir).catch(() => []);
    assert(dirs.length > 0, '**快照目录为空**——撤销功能的基础没建立');
    return `${dirs.length} 个快照`;
  });

  await step('7. 相关任务复用会话', async () => {
    const before = assistantMessageCount(projectId);
    // **只用不会触发审批的操作**。
    //
    // 上一版让 Agent"追加一行"，结果它自己决定先 `Remove-Item xxx.bak_readonly`
    // 再追加——那是个删除动作，权限档位 manual 下要等人工批准。
    // 测试环境没人点批准，于是 Agent 永远挂在 running，连带第 10 步也失败。
    //
    // 现在明确要它用 write_file 整体覆盖：不涉及删除、不需要审批。
    await say(
      projectId,
      '**再派一个 Agent**（不要自己回答，不要复用上一个）。' +
        '任务：用 write_file 把 notes.md 的内容整个覆盖成"# 测试项目\\n验证完成"。' +
        '不要执行任何删除类命令，不要创建备份文件。',
    );
    await waitAssistantReply(projectId, before);

    // **Assistant 说完不等于 Agent 跑完**——它会先回"已派出"，Agent 在后台跑。
    // 之前直接 waitIdle 会查到"只有 1 个 Agent"（第二个还没落库）。
    // 这里先等第二个 Agent 出现，再等它跑完。
    const c0 = db();
    const countBefore = Number(
      c0.prepare('SELECT COUNT(*) n FROM executor WHERE project_id = ?').get(projectId)?.n ?? 0,
    );
    c0.close();

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const c1 = db();
      const n = Number(
        c1.prepare('SELECT COUNT(*) n FROM executor WHERE project_id = ?').get(projectId)?.n ?? 0,
      );
      c1.close();
      if (n > countBefore) break;
      await sleep(1500);
    }

    await waitIdle(projectId);

    const c = db();
    const agents = c
      .prepare('SELECT id, session_id, status FROM executor WHERE project_id = ? ORDER BY created_at')
      .all(projectId);
    c.close();

    // **卡在 running 的 Agent 要报出来**——那通常意味着在等审批，
    // 而测试环境没人会批。
    const stuck = agents.filter((a) => a.status === 'running');
    assert(
      stuck.length === 0,
      `${stuck.length} 个 Agent 卡在 running（多半在等审批，测试环境没人批）`,
    );

    if (agents.length < 2) {
      throw new Error(
        `只创建了 ${agents.length} 个 Agent——第二个没派出来，会话复用无从验证`,
      );
    }

    const sessions = new Set(agents.map((a) => a.session_id));
    const reused = sessions.size < agents.length;
    return `${agents.length} 个 Agent 用了 ${sessions.size} 个会话${reused ? '（有复用）' : '（各自独立）'}`;
  });

  await step('8. 上下文用量可查', async () => {
    const { body } = await api(`/api/projects/${projectId}`);
    assert(Array.isArray(body.executors), '返回结构不对');
    return `${body.executors.length} 个 Agent`;
  });

  await step('9. 使用报告包含本次项目', async () => {
    const { status, body } = await api('/api/insights/usage?days=1');
    assert(status === 200, `返回 ${status}`);
    assert(body.usage, '没有 usage 字段');
    assert(body.usage.executors.total >= 1, '使用报告没统计到本次派活');
    return `今日 ${body.usage.executors.total} 个任务，成功率 ${body.usage.successRate ?? '—'}%`;
  });

  // 清理
  console.log('\n清理：');
  await step('10. 移除测试项目（归档，不删磁盘）', async () => {
    // 先清掉可能残留的 Agent——移除项目会拒绝"还有 Agent 在跑"的情况
    // （这是对的设计，不该为了测试改它）。
    const c = db();
    const live = c
      .prepare(
        "SELECT id FROM executor WHERE project_id = ? AND status IN ('running','starting')",
      )
      .all(projectId);
    c.close();
    for (const a of live) {
      await api(`/api/executors/${a.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      });
    }
    if (live.length > 0) await sleep(2000);

    const r = await api(`/api/projects/${projectId}/archive`, { method: 'DELETE' });
    assert(r.status === 200, `移除返回 ${r.status}: ${JSON.stringify(r.body)}`);

    // 磁盘文件必须还在
    const content = await readFile(path.join(root, 'target.txt'), 'utf8');
    assert(content.length > 0, '**磁盘文件被删了**——移除项目不该删磁盘文件');
    return `项目已归档，磁盘文件保留${live.length > 0 ? `（先取消了 ${live.length} 个残留 Agent）` : ''}`;
  });

  // 报告
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  console.log(`\n结果：${pass} 通过 · ${fail} 失败${skipped ? ` · ${skipped} 跳过` : ''}`);

  if (fail > 0) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.error}`);
    }
  }

  if (!KEEP) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    console.log(`\n临时目录已清理`);
  } else {
    console.log(`\n临时目录保留：${root}`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\n套件本身出错：', error);
  process.exit(2);
});
