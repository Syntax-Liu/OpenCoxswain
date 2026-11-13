/** 验证写域冲突提醒：强行派两个改同一文件的 Agent。 */
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const token = (await readFile(path.join(homedir(), '.opencoxswain', 'token'), 'utf8')).trim();
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const projects = await (await fetch('http://127.0.0.1:47900/api/projects', { headers: H })).json();
const project = (projects.projects ?? []).find((p) => /advmath/i.test(p.name));

// 建一个需要跑一会儿才能改的文件，给第二个 Agent 制造冲突窗口
await writeFile(path.join(project.displayPath, 'race-a.txt'), '初始', 'utf8');
await writeFile(path.join(project.displayPath, 'race-b.txt'), '初始', 'utf8');

const before = (await (await fetch(`http://127.0.0.1:47900/api/projects/${project.id}`, { headers: H })).json()).executors.map((e) => e.id);

// 明确要求：必须派两个独立 Agent，不要改投
await fetch(`http://127.0.0.1:47900/api/projects/${project.id}/say`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    text:
      '请**同时派出两个独立的 Agent**（不要合并、不要改投给同一个 Agent）：\n' +
      '  Agent1：用 write_file 把根目录 race-a.txt 改成"由A写"\n' +
      '  Agent2：用 write_file 把根目录 race-a.txt 改成"由B写"\n' +
      '注意：两个都要改同一个文件 race-a.txt。这是我要测试的场景，请照做。',
    source: 'webapp',
  }),
});
console.log('已派活（两个 Agent 抢同一文件）');

for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 5000));
  const d = await (await fetch(`http://127.0.0.1:47900/api/projects/${project.id}`, { headers: H })).json();
  const running = (d.executors ?? []).filter((e) => e.status === 'running' || e.status === 'starting');
  if (running.length === 0 && i >= 4) break;
  process.stdout.write('.');
}
console.log('');

const d = await (await fetch(`http://127.0.0.1:47900/api/projects/${project.id}`, { headers: H })).json();
const mine = (d.executors ?? []).filter((e) => !before.includes(e.id));
console.log('\n本次派出:', mine.length, '个');
for (const e of mine) {
  console.log(`  ${e.status.padEnd(8)} | 写域=${JSON.stringify(e.writeScope)} | ${String(e.label).slice(0, 40)}`);
}

// 查冲突通知
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(path.join(homedir(), '.opencoxswain', 'runtime.db'));
const adv = db.prepare('SELECT assistant_session_id s FROM project WHERE id = ?').get(project.id);
const notices = db
  .prepare("SELECT content, at FROM message WHERE session_id = ? AND content LIKE '%撞了写域%' ORDER BY seq DESC LIMIT 3")
  .all(adv.s);
db.close();

console.log('\n捡到写域冲突通知:', notices.length, '条');
for (const n of notices) {
  console.log(`\n[${new Date(Number(n.at)).toLocaleTimeString()}]`);
  console.log(String(n.content).replace(/\n/g, ' ').slice(0, 300));
}
